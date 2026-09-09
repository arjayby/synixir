defmodule Synixir.RoomAccess do
  @moduledoc "Room ownership, membership, and short-lived grants tied to revocable sessions."
  import Ecto.Query
  alias Synixir.{Accounts, Accounts.User, Documents, Repo}
  @salt "synixir room access v2"
  @max_age 15 * 60
  @roles ["owner", "editor", "viewer"]

  def issue(room, hash) when is_binary(hash) and byte_size(hash) == 32 do
    with_member(room, hash, "FOR SHARE", fn id, member, expires ->
      claims = %{
        room_id: room,
        user_id: id,
        session: Base.url_encode64(hash, padding: false),
        version: member.version
      }

      token = Phoenix.Token.sign(SynixirWeb.Endpoint, @salt, claims)
      %{token: token, user_id: id, role: member.role, expires_at: expires}
    end)
  end

  def issue(_, _), do: {:error, :invalid_claims}

  def verify(room, token) when is_binary(token) do
    with {:ok, %{room_id: ^room, user_id: id, session: encoded, version: version}} <-
           Phoenix.Token.verify(SynixirWeb.Endpoint, @salt, token, max_age: @max_age),
         true <- Documents.valid_room_id?(room) and is_integer(version) and version > 0,
         {:ok, ^id} <- Ecto.UUID.cast(id),
         {:ok, hash} <- Base.url_decode64(encoded, padding: false),
         true <- byte_size(hash) == 32 do
      grant = %{room_id: room, user_id: id, session_hash: hash, version: version}

      with {:ok, %{role: role, expires_at: expires}} <- with_access(grant, :read, & &1) do
        {:ok, Map.merge(grant, %{role: role, expires_at: expires})}
      end
    else
      _ -> {:error, :unauthorized}
    end
  rescue
    _ -> {:error, :unauthorized}
  end

  def verify(_, _), do: {:error, :unauthorized}

  # Run this INSIDE the room worker, including apply + append. Membership
  # changes take FOR UPDATE on the same room row. Session deletion conflicts
  # with lock_session. The transaction must commit before the worker replies.
  def with_access(grant, operation, fun) do
    with_member(grant.room_id, grant.session_hash, "FOR SHARE", fn id, member, expires ->
      cond do
        id != grant.user_id or member.version != grant.version -> Repo.rollback(:unauthorized)
        operation == :write and member.role == "viewer" -> Repo.rollback(:read_only)
        true -> fun.(%{role: member.role, expires_at: expires})
      end
    end)
  end

  defp with_member(room, hash, lock, fun) do
    Repo.transaction(fn ->
      with {:ok, id, expires} <- Accounts.lock_session(hash),
           true <- lock_room(room, lock),
           %{revoked_at: nil} = member <- membership(room, id) do
        fun.(id, member, expires)
      else
        _ -> Repo.rollback(:unauthorized)
      end
    end)
  end

  defp lock_room(room, lock) do
    query = from r in "rooms", where: r.id == ^room, select: r.id
    query = if lock == "FOR UPDATE", do: lock(query, "FOR UPDATE"), else: lock(query, "FOR SHARE")
    Repo.one(query) != nil
  end

  defp membership(room, id) do
    binary_id = Ecto.UUID.dump!(id)

    Repo.one(
      from m in "room_memberships",
        where: m.room_id == ^room and m.user_id == ^binary_id,
        select: %{role: m.role, version: m.version, revoked_at: m.revoked_at}
    )
  end

  def create_room(room, hash) do
    if Documents.valid_room_id?(room) do
      Repo.transaction(fn ->
        case Accounts.lock_session(hash) do
          {:ok, id, _expires} -> create_owned_room(room, id, false)
          _ -> Repo.rollback(:unauthorized)
        end
      end)
    else
      {:error, :invalid_room}
    end
  end

  @doc "Trusted migration API: assigns a legacy document to an explicitly chosen existing account."
  def adopt_legacy_room(room, %User{id: id}) do
    if Documents.valid_room_id?(room),
      do: Repo.transaction(fn -> create_owned_room(room, id, true) end),
      else: {:error, :invalid_room}
  end

  defp create_owned_room(room, id, legacy?) do
    Repo.query!("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [room])

    if not legacy? and
         (Repo.exists?(from u in "document_updates", where: u.room_id == ^room) or
            Repo.exists?(from s in "document_snapshots", where: s.room_id == ^room)) do
      Repo.rollback(:room_unavailable)
    end

    now = DateTime.utc_now()

    case Repo.insert_all("rooms", [%{id: room, inserted_at: now}], on_conflict: :nothing) do
      {1, _} ->
        Repo.insert_all("room_memberships", [
          %{
            room_id: room,
            user_id: Ecto.UUID.dump!(id),
            role: "owner",
            version: 1,
            inserted_at: now,
            updated_at: now
          }
        ])

        %{id: room, role: "owner"}

      _ ->
        Repo.rollback(:room_unavailable)
    end
  end

  def list_rooms(hash) do
    Repo.transaction(fn ->
      with {:ok, id, _} <- Accounts.lock_session(hash) do
        binary_id = Ecto.UUID.dump!(id)

        Repo.all(
          from m in "room_memberships",
            where: m.user_id == ^binary_id and is_nil(m.revoked_at),
            order_by: m.room_id,
            select: %{id: m.room_id, role: m.role}
        )
      else
        _ -> Repo.rollback(:unauthorized)
      end
    end)
  end

  def members(room, hash) do
    with_member(room, hash, "FOR SHARE", fn _id, member, _expires ->
      if member.role != "owner", do: Repo.rollback(:forbidden)

      Repo.all(
        from m in "room_memberships",
          join: u in User,
          on: u.id == m.user_id,
          where: m.room_id == ^room and is_nil(m.revoked_at),
          order_by: u.username,
          select: %{user_id: u.id, username: u.username, role: m.role}
      )
    end)
  end

  def set_member(room, hash, username, role) when role in @roles or is_nil(role) do
    result =
      with_member(room, hash, "FOR UPDATE", fn _id, actor, _expires ->
        if actor.role != "owner", do: Repo.rollback(:forbidden)

        user =
          if is_binary(username),
            do: Repo.get_by(User, username: String.downcase(String.trim(username)))

        if is_nil(user), do: Repo.rollback(:account_not_found)
        current = membership(room, user.id)

        if current && current.revoked_at == nil && current.role == "owner" && role != "owner" do
          owners =
            Repo.aggregate(
              from(m in "room_memberships",
                where:
                  m.room_id == ^room and
                    m.role == "owner" and is_nil(m.revoked_at)
              ),
              :count
            )

          if owners == 1, do: Repo.rollback(:last_owner)
        end

        now = DateTime.utc_now()
        version = if current, do: current.version + 1, else: 1

        Repo.insert_all(
          "room_memberships",
          [
            %{
              room_id: room,
              user_id: Ecto.UUID.dump!(user.id),
              role: role || (current && current.role) || "viewer",
              version: version,
              revoked_at: if(is_nil(role), do: now),
              inserted_at: now,
              updated_at: now
            }
          ],
          on_conflict: {:replace, [:role, :version, :revoked_at, :updated_at]},
          conflict_target: [:room_id, :user_id]
        )

        user.id
      end)

    case result do
      {:ok, id} ->
        Phoenix.PubSub.broadcast(Synixir.PubSub, member_topic(room, id), :access_revoked)
        {:ok, %{username: username, role: role}}

      error ->
        error
    end
  end

  def set_member(_, _, _, _), do: {:error, :invalid_role}

  def member_topic(room, user_id), do: "membership:" <> room <> ":" <> user_id
end

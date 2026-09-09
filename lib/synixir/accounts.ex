defmodule Synixir.Accounts do
  @moduledoc "Persistent accounts and revocable, expiring browser sessions."
  import Ecto.Query
  alias Synixir.{Repo, Accounts.User}
  @session_seconds 7 * 24 * 60 * 60

  def register(attrs), do: attrs |> User.registration() |> Repo.insert()

  def authenticate(username, password)
      when is_binary(username) and is_binary(password) and
             byte_size(username) <= 128 and byte_size(password) <= 1024 do
    user = Repo.get_by(User, username: String.downcase(String.trim(username)))

    if user && Argon2.verify_pass(password, user.hashed_password) do
      {:ok, user}
    else
      if is_nil(user), do: Argon2.no_user_verify()
      {:error, :invalid_credentials}
    end
  end

  def authenticate(_, _), do: {:error, :invalid_credentials}

  def create_session(%User{id: id}) do
    raw = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
    now = DateTime.utc_now()

    Repo.insert_all("user_sessions", [
      %{
        token_hash: digest(raw),
        user_id: Ecto.UUID.dump!(id),
        expires_at: DateTime.add(now, @session_seconds),
        inserted_at: now
      }
    ])

    raw
  end

  def session(raw) when is_binary(raw) do
    hash = digest(raw)

    case Repo.one(
           from s in "user_sessions",
             join: u in User,
             on: u.id == s.user_id,
             where: s.token_hash == ^hash and s.expires_at > ^DateTime.utc_now(),
             select: u
         ) do
      nil -> nil
      user -> %{user: user, session_hash: hash}
    end
  end

  def session(_), do: nil

  def revoke_session(raw) when is_binary(raw) do
    hash = digest(raw)
    Repo.delete_all(from s in "user_sessions", where: s.token_hash == ^hash)
    Phoenix.PubSub.broadcast(Synixir.PubSub, session_topic(hash), :access_revoked)
    :ok
  end

  def revoke_session(_), do: :ok

  # Called inside the same transaction as room authorization and persistence.
  # DELETE on logout conflicts with this lock, ordering logout with in-flight writes.
  def lock_session(hash) do
    case Repo.one(
           from s in "user_sessions",
             where: s.token_hash == ^hash,
             lock: "FOR SHARE",
             select: %{user_id: s.user_id, expires_at: type(s.expires_at, :utc_datetime_usec)}
         ) do
      %{user_id: id, expires_at: expires_at} ->
        if DateTime.compare(expires_at, DateTime.utc_now()) == :gt,
          do: {:ok, Ecto.UUID.load!(id), expires_at},
          else: {:error, :unauthorized}

      nil ->
        {:error, :unauthorized}
    end
  end

  def session_topic(hash), do: "session:" <> Base.url_encode64(hash, padding: false)
  defp digest(raw), do: :crypto.hash(:sha256, raw)
end

defmodule Synixir.RestoreCheck do
  import Ecto.Query
  alias Synixir.{Accounts, Accounts.User, Documents.Store, Repo, RoomAccess}
  @password "restore drill password, fixtures only"

  def seed(path) do
    users =
      for name <- ~w(owner editor viewer revoked), into: %{} do
        {:ok, user} = Accounts.register(%{username: "drill_" <> name, password: @password})
        raw = Accounts.create_session(user)
        {name, %{user: user, raw: raw, hash: :crypto.hash(:sha256, raw)}}
      end

    owner = users["owner"]

    for room <- ~w(drill_text drill_pending_insert drill_pending_delete) do
      {:ok, _} = RoomAccess.create_room(room, owner.hash)
    end

    for role <- ~w(editor viewer revoked) do
      {:ok, _} = RoomAccess.set_member("drill_text", owner.hash, "drill_" <> role, "editor")
    end

    {:ok, _} = RoomAccess.set_member("drill_text", owner.hash, "drill_viewer", "viewer")
    {:ok, old_grant} = RoomAccess.issue("drill_text", users["revoked"].hash)
    {:ok, _} = RoomAccess.set_member("drill_text", owner.hash, "drill_revoked", nil)
    revoked_session = Accounts.create_session(owner.user)
    :ok = Accounts.revoke_session(revoked_session)

    client = Yex.Doc.with_options(%Yex.Doc.Options{offset_kind: :utf16})
    text = Yex.Doc.get_text(client, "content")
    :ok = Yex.Text.insert(text, 0, "abc🌍")
    {:ok, base} = Yex.encode_state_as_update(client)
    {:ok, vector} = Yex.encode_state_vector(client)
    :ok = Yex.Text.insert(text, 5, "!")
    {:ok, insertion} = Yex.encode_state_as_update(client, vector)
    {:ok, vector} = Yex.encode_state_vector(client)
    :ok = Yex.Text.delete(text, 1, 1)
    {:ok, deletion} = Yex.encode_state_as_update(client, vector)
    for data <- [base, insertion], do: :ok = Store.append("drill_text", data)
    :ok = Store.compact("drill_text")
    :ok = Store.append("drill_text", deletion)
    :ok = Store.append("drill_pending_insert", insertion)
    :ok = Store.compact("drill_pending_insert")
    :ok = Store.append("drill_pending_delete", deletion)
    :ok = Store.compact("drill_pending_delete")

    expectations = %{
      base: Base.encode64(base),
      sessions: Map.new(users, fn {name, user} -> {name, user.raw} end),
      passwords: Map.new(users, fn {name, user} -> {name, user.user.hashed_password} end),
      revoked_session: revoked_session,
      revoked_grant: old_grant.token
    }

    File.write!(path, Jason.encode!(expectations))
  end

  def verify do
    true = Synixir.Operations.Health.ready?()
    applied = Repo.all(from m in "schema_migrations", order_by: m.version, select: m.version)

    expected =
      Path.wildcard("priv/repo/migrations/*.exs")
      |> Enum.map(&(Path.basename(&1) |> String.split("_") |> hd() |> String.to_integer()))
      |> Enum.sort()

    if applied != expected, do: raise("archive schema does not match this checkout")
    %{rows: [[0]]} = Repo.query!("SELECT count(*) FROM pg_index WHERE NOT indisvalid")

    # Check every persisted binary, including pending updates that have no visible text.
    for table <- ["document_updates", "document_snapshots"] do
      Repo.transaction(fn ->
        Repo.stream(from row in table, select: {row.data, row.digest})
        |> Enum.each(fn {data, digest} ->
          if :crypto.hash(:sha256, data) != digest, do: raise("stored checksum mismatch")
          :ok = Yex.apply_update(Yex.Doc.new(), data)
        end)
      end)
      |> then(fn {:ok, _} -> :ok end)
    end

    %{rows: rooms} =
      Repo.query!("""
      SELECT id FROM rooms UNION SELECT room_id FROM document_updates
      UNION SELECT room_id FROM document_snapshots
      """)

    Enum.each(rooms, fn [room] -> Store.restore(room, Yex.Doc.new()) end)

    %{
      rooms_verified: length(rooms),
      migrations: applied,
      users: Repo.aggregate(User, :count),
      updates: Repo.aggregate("document_updates", :count),
      snapshots: Repo.aggregate("document_snapshots", :count)
    }
  end

  def drill_verify(path) do
    fixture = path |> File.read!() |> Jason.decode!()

    for name <- ~w(owner editor viewer revoked) do
      {:ok, user} = Accounts.authenticate("drill_" <> name, @password)
      true = user.hashed_password == fixture["passwords"][name]
      %{user: restored} = Accounts.session(fixture["sessions"][name])
      true = restored.id == user.id
    end

    nil = Accounts.session(fixture["revoked_session"])
    {:error, :unauthorized} = RoomAccess.verify("drill_text", fixture["revoked_grant"])

    for {name, role} <- [{"owner", "owner"}, {"editor", "editor"}, {"viewer", "viewer"}] do
      hash = :crypto.hash(:sha256, fixture["sessions"][name])
      {:ok, %{role: ^role}} = RoomAccess.issue("drill_text", hash)
    end

    %{rows: [[2, true]]} =
      Repo.query!("""
      SELECT m.version, m.revoked_at IS NOT NULL FROM room_memberships m
      JOIN users u ON u.id = m.user_id WHERE m.room_id = 'drill_text' AND u.username = 'drill_revoked'
      """)

    "ac🌍!" = content("drill_text")
    "" = content("drill_pending_insert")
    "" = content("drill_pending_delete")
    base = Base.decode64!(fixture["base"])

    %{rows: [[before]]} =
      Repo.query!("""
      SELECT greatest(coalesce((SELECT max(id) FROM document_updates), 0),
                      coalesce((SELECT max(through_id) FROM document_snapshots), 0))
      """)

    :ok = Store.append("drill_pending_insert", base)
    :ok = Store.append("drill_pending_delete", base)
    %{rows: [[after_id]]} = Repo.query!("SELECT max(id) FROM document_updates")
    true = after_id > before
    "abc🌍!" = content("drill_pending_insert")
    "ac🌍" = content("drill_pending_delete")

    # A restored foreign key and role constraint must still reject invalid rows.
    {:error, %Postgrex.Error{postgres: %{code: :foreign_key_violation}}} =
      Repo.query("""
      INSERT INTO user_sessions(token_hash, user_id, expires_at, inserted_at)
      VALUES ('bad', '00000000-0000-0000-0000-000000000000', now(), now())
      """)

    {:error, %Postgrex.Error{postgres: %{code: :check_violation}}} =
      Repo.query("""
      UPDATE room_memberships SET role = 'invalid' WHERE room_id = 'drill_text'
      """)

    {:ok, _} = Accounts.register(%{username: "after_restore", password: @password})

    %{
      passwords_sessions_roles: true,
      revocation: true,
      snapshot_tail: true,
      pending_insert_and_delete: true,
      sequences_and_constraints: true
    }
  end

  defp content(room) do
    doc = Yex.Doc.with_options(%Yex.Doc.Options{offset_kind: :utf16})
    Store.restore(room, doc)
    Yex.Text.to_string(Yex.Doc.get_text(doc, "content"))
  end
end

database = System.fetch_env!("SYNIXIR_OPERATIONS_DATABASE")
true = Synixir.Repo.config()[:database] == database

result =
  case System.argv() do
    ["seed", path] ->
      Synixir.RestoreCheck.seed(path)
      %{seeded: true}

    ["verify"] ->
      Synixir.RestoreCheck.verify()

    ["drill-verify", path] ->
      Map.merge(Synixir.RestoreCheck.verify(), Synixir.RestoreCheck.drill_verify(path))
  end

IO.puts("OPERATIONS_RESULT=" <> Jason.encode!(result))

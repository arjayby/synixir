defmodule Synixir.AuthorizationCommitTest do
  use ExUnit.Case, async: false
  import Ecto.Query
  import Synixir.AccessHelpers
  alias Synixir.{Accounts, Accounts.User, RoomAccess, Repo, Documents.Store}
  alias Ecto.Adapters.SQL.Sandbox

  test "logout waits for an authorized write to commit, and the save is acknowledged only after commit" do
    room = "auth-commit-#{Ecto.UUID.generate()}"

    {actor, grant} =
      Sandbox.unboxed_run(Repo, fn ->
        actor = account_fixture("writer")
        {:ok, _} = RoomAccess.create_room(room, actor.hash)
        {:ok, %{token: token}} = RoomAccess.issue(room, actor.hash)
        {:ok, grant} = RoomAccess.verify(room, token)
        {actor, grant}
      end)

    on_exit(fn ->
      Sandbox.unboxed_run(Repo, fn ->
        Repo.delete_all(from u in "document_updates", where: u.room_id == ^room)
        Repo.delete_all(from r in "rooms", where: r.id == ^room)
        Repo.delete_all(from u in User, where: u.id == ^actor.user.id)
      end)
    end)

    parent = self()

    {writer, writer_ref} =
      spawn_monitor(fn ->
        receive do
          :start -> :ok
        end

        Sandbox.unboxed_run(Repo, fn ->
          doc = Yex.Doc.new()
          :ok = Yex.Text.insert(Yex.Doc.get_text(doc, "content"), 0, "committed")
          {:ok, data} = Yex.encode_state_as_update(doc)
          target = Yex.Doc.new()

          result =
            Store.append_authorized(room, data, grant, fn -> Yex.apply_update(target, data) end)

          send(parent, {:saved, result})
        end)
      end)

    handler = "pause-authorized-write-#{Ecto.UUID.generate()}"

    :ok =
      :telemetry.attach(
        handler,
        [:synixir, :repo, :query],
        &__MODULE__.pause_insert/4,
        {parent, writer}
      )

    on_exit(fn ->
      :telemetry.detach(handler)
      if Process.alive?(writer), do: Process.exit(writer, :kill)
    end)

    send(writer, :start)
    assert_receive :inserted, 2000

    {revoker, revoke_ref} =
      spawn_monitor(fn ->
        Sandbox.unboxed_run(Repo, fn ->
          Accounts.revoke_session(actor.raw)
          send(parent, :revoked)
        end)
      end)

    on_exit(fn -> if Process.alive?(revoker), do: Process.exit(revoker, :kill) end)
    refute_receive {:saved, _}, 100
    refute_receive :revoked, 100
    send(writer, :continue)
    assert_receive {:saved, :ok}, 2000
    assert_receive :revoked, 2000
    assert_receive {:DOWN, ^writer_ref, :process, ^writer, :normal}, 2000
    assert_receive {:DOWN, ^revoke_ref, :process, ^revoker, :normal}, 2000

    Sandbox.unboxed_run(Repo, fn ->
      assert {:error, :unauthorized} = RoomAccess.with_access(grant, :write, fn _ -> :bad end)
      restored = Yex.Doc.new()
      Store.restore(room, restored)
      assert Yex.Text.to_string(Yex.Doc.get_text(restored, "content")) == "committed"
    end)
  end

  def pause_insert(_event, _measurements, metadata, {parent, writer}) do
    if self() == writer and
         String.starts_with?(metadata.query, "INSERT INTO \"document_updates\"") do
      send(parent, :inserted)

      receive do
        :continue -> :ok
      end
    end
  end
end

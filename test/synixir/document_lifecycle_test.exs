defmodule Synixir.DocumentLifecycleTest do
  use Synixir.DataCase, async: false
  alias Synixir.Documents
  alias Yex.Sync.SharedDoc

  test "snapshots preserve pending inserts and delete sets through repeated compaction and crashes" do
    room = "compact-pending-#{Ecto.UUID.generate()}"
    client = Yex.Doc.new()
    text = Yex.Doc.get_text(client, "content")
    :ok = Yex.Text.insert(text, 0, "abc")
    {:ok, base} = Yex.encode_state_as_update(client)
    {:ok, vector} = Yex.encode_state_vector(client)
    :ok = Yex.Text.insert(text, 3, "!")
    {:ok, pending_insert} = Yex.encode_state_as_update(client, vector)
    {:ok, vector} = Yex.encode_state_vector(client)
    :ok = Yex.Text.delete(text, 1, 1)
    {:ok, pending_delete} = Yex.encode_state_as_update(client, vector)

    # Another client refers to an item that the server has never received.
    other = Yex.Doc.new()
    :ok = Yex.apply_update(other, base)
    {:ok, vector} = Yex.encode_state_vector(other)
    :ok = Yex.Text.insert(Yex.Doc.get_text(other, "content"), 0, "?")
    {:ok, cross_client} = Yex.encode_state_as_update(other, vector)
    :ok = Yex.apply_update(client, cross_client)
    expected = Yex.Text.to_string(text)

    {:ok, owner} = Documents.open(room)

    for update <- [pending_delete, pending_insert, cross_client] do
      assert {:ok, [], true} = Documents.save_update(owner, update)
    end

    assert :ok = Documents.compact(owner)
    assert log_count(room) == 0
    assert snapshot(room)
    stop(owner)

    {:ok, owner} = Documents.open(room)
    assert content(owner) == ""
    # Repeated compaction must merge the previous snapshot, including pending data.
    assert {:ok, [], true} = Documents.save_update(owner, pending_insert)
    assert :ok = Documents.compact(owner)
    stop(owner)
    {:ok, owner} = Documents.open(room)
    assert {:ok, [], true} = Documents.save_update(owner, base)
    assert content(owner) == expected
    assert :ok = Documents.compact(owner)
    stop(owner)

    {:ok, owner} = Documents.open(room)
    assert content(owner) == expected
    assert {:ok, [], true} = Documents.save_update(owner, base)
    assert content(owner) == expected
    stop(owner)
  end

  test "a failed prune rolls back the snapshot replacement and preserves the old snapshot and tail" do
    room = "compact-rollback-#{Ecto.UUID.generate()}"
    {:ok, owner} = Documents.open(room)
    assert {:ok, [], true} = Documents.save_update(owner, update("old"))
    assert :ok = Documents.compact(owner)
    previous = snapshot(room)
    assert {:ok, [], true} = Documents.save_update(owner, update("tail"))
    before = content(owner)

    # Reject the DELETE after the new snapshot was written. Savepoint rollback
    # must restore both tables. This runs against PostgreSQL, not a mock store.
    Repo.query!("""
    CREATE FUNCTION pg_temp.reject_compaction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'interrupted compaction'; END $$
    """)

    Repo.query!("""
    CREATE TRIGGER reject_compaction BEFORE DELETE ON document_updates
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_compaction()
    """)

    assert {:error, :storage_unavailable} = Documents.compact(owner)
    assert snapshot(room) == previous
    assert log_count(room) == 1
    stop(owner)
    {:ok, owner} = Documents.open(room)
    assert content(owner) == before
    stop(owner)
  end

  test "a corrupt snapshot refuses restoration instead of silently dropping saved state" do
    room = "corrupt-snapshot-#{Ecto.UUID.generate()}"
    {:ok, owner} = Documents.open(room)
    assert {:ok, [], true} = Documents.save_update(owner, update("saved"))
    assert :ok = Documents.compact(owner)
    stop(owner)

    Repo.update_all(from(s in "document_snapshots", where: s.room_id == ^room),
      set: [data: <<0, 0>>]
    )

    assert {:error, _} = Documents.open(room)
  end

  test "automatic compaction bounds the log and idle eviction restores saved text on demand" do
    configure(idle_timeout_ms: 50, compact_after_updates: 2)
    room = "idle-#{Ecto.UUID.generate()}"
    {:ok, owner} = Documents.open(room)
    :ok = SharedDoc.observe(owner)
    assert {:ok, [], true} = Documents.save_update(owner, update("first"))
    assert {:ok, [], true} = Documents.save_update(owner, update("second"))
    # The call follows the queued compaction in the room mailbox.
    expected = content(owner)
    assert snapshot(room)
    assert log_count(room) == 0
    Process.sleep(75)
    assert Process.alive?(owner)
    monitor = Process.monitor(owner)
    assert :ok = SharedDoc.unobserve(owner)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :normal}, 500
    assert Registry.lookup(Documents.Registry, room) == []
    {:ok, restored} = Documents.open(room)
    assert content(restored) == expected
    stop(restored)
  end

  test "a new observer cancels stale eviction and the last observer crash starts a new grace period" do
    configure(idle_timeout_ms: 100)
    room = "idle-race-#{Ecto.UUID.generate()}"
    {:ok, owner} = Documents.open(room)
    state = :sys.get_state(owner)
    {_timer, stale} = state.assigns.idle_timer
    :ok = SharedDoc.observe(owner)
    send(owner, {:idle, stale})
    assert content(owner) == ""
    parent = self()

    observer =
      spawn(fn ->
        :ok = SharedDoc.observe(owner)
        send(parent, :observing)

        receive do
          :done -> :ok
        end
      end)

    assert_receive :observing
    :ok = SharedDoc.unobserve(owner)
    Process.sleep(125)
    assert Process.alive?(owner)
    monitor = Process.monitor(owner)
    Process.exit(observer, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :normal}, 500
  end

  defp configure(options) do
    previous = Application.fetch_env!(:synixir, :document_lifecycle)
    Application.put_env(:synixir, :document_lifecycle, Keyword.merge(previous, options))
    on_exit(fn -> Application.put_env(:synixir, :document_lifecycle, previous) end)
  end

  defp update(value) do
    client = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(client, "content"), 0, value)
    {:ok, update} = Yex.encode_state_as_update(client)
    update
  end

  defp content(owner) do
    client = Yex.Doc.new()
    {:ok, step1} = Yex.Sync.get_sync_step1(client)

    assert {:ok, [reply | _], false} =
             Documents.sync(owner, Yex.Sync.message_encode!({:sync, step1}))

    {:ok, {:sync, {:sync_step2, update}}} = Yex.Sync.message_decode(reply)
    :ok = Yex.apply_update(client, update)
    Yex.Text.to_string(Yex.Doc.get_text(client, "content"))
  end

  defp snapshot(room),
    do: Repo.one(from s in "document_snapshots", where: s.room_id == ^room, select: s.data)

  defp log_count(room),
    do: Repo.aggregate(from(u in "document_updates", where: u.room_id == ^room), :count)

  defp stop(owner) do
    monitor = Process.monitor(owner)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}
  end
end

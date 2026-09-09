defmodule Synixir.CompactionCrashTest do
  use ExUnit.Case, async: false
  import Ecto.Query
  alias Synixir.{Repo, Documents.Store}
  alias Ecto.Adapters.SQL.Sandbox

  @tag capture_log: true
  test "killing a compactor after snapshot insertion rolls back replacement and pruning" do
    room = "compactor-crash-#{Ecto.UUID.generate()}"

    on_exit(fn ->
      Sandbox.unboxed_run(Repo, fn ->
        Repo.delete_all(from u in "document_updates", where: u.room_id == ^room)
        Repo.delete_all(from s in "document_snapshots", where: s.room_id == ^room)
      end)
    end)

    # These are real commits outside the SQL sandbox, so killing the connection
    # owner tests PostgreSQL rollback rather than a surrounding test transaction.
    previous =
      Sandbox.unboxed_run(Repo, fn ->
        :ok = Store.append(room, update("old"))
        :ok = Store.compact(room)
        :ok = Store.append(room, update("tail"))
        snapshot(room)
      end)

    expected = restore(room)
    parent = self()

    {worker, monitor} =
      spawn_monitor(fn ->
        receive do
          :start -> :ok
        end

        Sandbox.unboxed_run(Repo, fn -> Store.compact(room) end)
      end)

    handler = "pause-compactor-#{Ecto.UUID.generate()}"

    :ok =
      :telemetry.attach(
        handler,
        [:synixir, :repo, :query],
        &__MODULE__.pause_after_insert/4,
        {parent, worker}
      )

    on_exit(fn ->
      :telemetry.detach(handler)
      if Process.alive?(worker), do: Process.exit(worker, :kill)
    end)

    send(worker, :start)
    assert_receive {:snapshot_inserted, ^worker}, 2000
    Process.exit(worker, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^worker, :killed}
    # Restore takes the same lock, waiting for the dead transaction to release it.
    assert restore(room) == expected

    Sandbox.unboxed_run(Repo, fn ->
      assert snapshot(room) == previous
      assert Repo.aggregate(from(u in "document_updates", where: u.room_id == ^room), :count) == 1
      assert :ok = Store.compact(room)
      assert Repo.aggregate(from(u in "document_updates", where: u.room_id == ^room), :count) == 0
    end)

    assert restore(room) == expected
  end

  test "restore holds a consistent snapshot and tail while another process compacts" do
    room = "restore-race-#{Ecto.UUID.generate()}"

    on_exit(fn ->
      Sandbox.unboxed_run(Repo, fn ->
        Repo.delete_all(from u in "document_updates", where: u.room_id == ^room)
        Repo.delete_all(from s in "document_snapshots", where: s.room_id == ^room)
      end)
    end)

    Sandbox.unboxed_run(Repo, fn ->
      :ok = Store.append(room, update("snapshot"))
      :ok = Store.compact(room)
      :ok = Store.append(room, update("tail"))
    end)

    expected = restore(room)
    parent = self()

    {reader, read_monitor} =
      spawn_monitor(fn ->
        receive do
          :start -> :ok
        end

        send(parent, {:restored, restore(room)})
      end)

    handler = "pause-restore-#{Ecto.UUID.generate()}"

    :ok =
      :telemetry.attach(
        handler,
        [:synixir, :repo, :query],
        &__MODULE__.pause_after_read/4,
        {parent, reader}
      )

    send(reader, :start)
    assert_receive {:snapshot_read, ^reader}, 2000

    {compactor, compact_monitor} =
      spawn_monitor(fn ->
        send(parent, :compacting)
        Sandbox.unboxed_run(Repo, fn -> Store.compact(room) end)
      end)

    on_exit(fn ->
      :telemetry.detach(handler)
      for pid <- [reader, compactor], Process.alive?(pid), do: Process.exit(pid, :kill)
    end)

    assert_receive :compacting
    # Without the shared room lock this commit can delete the tail between
    # restore's two reads, losing its acknowledged edits from the restored doc.
    refute_receive {:DOWN, ^compact_monitor, :process, ^compactor, _}, 100
    send(reader, :continue)
    assert_receive {:restored, ^expected}, 2000
    assert_receive {:DOWN, ^read_monitor, :process, ^reader, :normal}, 2000
    assert_receive {:DOWN, ^compact_monitor, :process, ^compactor, :normal}, 2000
    assert restore(room) == expected
  end

  def pause_after_read(_event, _measurements, metadata, {parent, reader}) do
    if self() == reader and String.contains?(metadata.query, "FROM \"document_snapshots\"") do
      send(parent, {:snapshot_read, reader})

      receive do
        :continue -> :ok
      end
    end
  end

  def pause_after_insert(_event, _measurements, metadata, {parent, worker}) do
    if self() == worker and
         String.starts_with?(metadata.query, "INSERT INTO \"document_snapshots\"") do
      send(parent, {:snapshot_inserted, worker})

      receive do
        :continue -> :ok
      end
    end
  end

  defp restore(room) do
    Sandbox.unboxed_run(Repo, fn ->
      doc = Yex.Doc.new()
      Store.restore(room, doc)
      Yex.Text.to_string(Yex.Doc.get_text(doc, "content"))
    end)
  end

  defp snapshot(room),
    do: Repo.one(from s in "document_snapshots", where: s.room_id == ^room, select: s.data)

  defp update(value) do
    doc = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(doc, "content"), 0, value)
    {:ok, update} = Yex.encode_state_as_update(doc)
    update
  end
end

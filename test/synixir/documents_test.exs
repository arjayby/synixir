defmodule Synixir.DocumentsTest do
  use ExUnit.Case, async: true

  alias Synixir.Documents

  test "invalid room IDs are rejected before opening a document" do
    for room_id <- [nil, 42, "", "room/other", "room space", String.duplicate("a", 129)] do
      assert {:error, :invalid_room_id} = Documents.open(room_id)
    end
  end

  test "concurrent callers opening the same room share one document process" do
    room_id = "concurrent-#{System.unique_integer([:positive])}"

    results =
      1..24
      |> Task.async_stream(fn _ -> Documents.open(room_id) end, max_concurrency: 24)
      |> Enum.map(fn {:ok, result} -> result end)

    assert [{:ok, doc}] = Enum.uniq(results)
    assert Process.alive?(doc)
    assert {:ok, ^doc} = Documents.open(room_id)
  end

  test "a crashed document is replaced without restarting another room" do
    room_id = "restart-#{System.unique_integer([:positive])}"
    {:ok, doc} = Documents.open(room_id)
    {:ok, other} = Documents.open("other-#{room_id}")
    ref = Process.monitor(doc)

    Process.exit(doc, :kill)
    assert_receive {:DOWN, ^ref, :process, ^doc, :killed}

    replacement = await_replacement(room_id, doc, 100)
    assert is_pid(replacement)
    assert replacement != doc
    assert {:ok, ^other} = Documents.open("other-#{room_id}")
    assert Process.alive?(other)
  end

  defp await_replacement(_room_id, _old, 0), do: flunk("document was not restarted")

  defp await_replacement(room_id, old, attempts) do
    case Documents.open(room_id) do
      {:ok, pid} when pid != old ->
        if Process.alive?(pid), do: pid, else: await_replacement(room_id, old, attempts - 1)

      _ ->
        Process.sleep(10)
        await_replacement(room_id, old, attempts - 1)
    end
  end
end

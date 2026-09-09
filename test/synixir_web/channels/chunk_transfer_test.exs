defmodule SynixirWeb.ChunkTransferTest do
  use Synixir.DataCase, async: false
  import Phoenix.ChannelTest
  alias Synixir.{Documents, RoomAccess}
  alias SynixirWeb.{DocumentSocket, ChunkTransfer}
  @endpoint SynixirWeb.Endpoint

  setup do
    previous = Application.fetch_env!(:synixir, :collaboration_limits)

    Application.put_env(
      :synixir,
      :collaboration_limits,
      Keyword.merge(previous,
        max_message_bytes: 128,
        chunk_bytes: 64,
        max_transfer_bytes: 1024,
        transfer_timeout_ms: 1000
      )
    )

    on_exit(fn -> Application.put_env(:synixir, :collaboration_limits, previous) end)
    :ok
  end

  test "only a complete validated upload is saved; broadcasts and initial sync are bounded" do
    {room, writer} = join_room()
    {_room, reader} = join_room(room)
    data = update(String.duplicate("x", 300))
    chunks = upload_chunks(data)

    for chunk <- Enum.drop(chunks, -1) do
      ref = push(writer, "transfer_chunk", {:binary, chunk})
      assert_reply ref, :ok, %{saved: false}
      assert log_count(room) == 0
    end

    refute_push "yjs_chunk", _
    ref = push(writer, "transfer_chunk", {:binary, List.last(chunks)})
    assert_reply ref, :ok, %{saved: true}
    assert log_count(room) == 1

    assert Repo.one(from u in "document_updates", where: u.room_id == ^room, select: u.data) ==
             data

    broadcast = receive_message()
    {:ok, {:sync, {:sync_update, raw}}} = Yex.Sync.message_decode(broadcast)
    assert text(raw) == String.duplicate("x", 300)

    empty = Yex.Doc.new()
    {:ok, step1} = Yex.Sync.get_sync_step1(empty)
    ref = push(writer, "yjs_sync", {:binary, Yex.Sync.message_encode!({:sync, step1})})
    assert_reply ref, :ok, %{saved: false}
    response = receive_message()
    {:ok, {:sync, {:sync_step2, raw}}} = Yex.Sync.message_decode(response)
    assert text(raw) == String.duplicate("x", 300)
    {:ok, owner} = Documents.open(room)
    stop(owner, [writer, reader])
  end

  test "malformed, oversized, expired and out-of-order transfers cannot mutate the room" do
    limits = Application.fetch_env!(:synixir, :collaboration_limits)

    Application.put_env(
      :synixir,
      :collaboration_limits,
      Keyword.put(limits, :transfer_timeout_ms, 100)
    )

    {room, writer} = join_room()
    data = update(String.duplicate("x", 200))
    [first, second | _] = upload_chunks(data)

    for {message, reason} <- [
          {<<>>, "invalid_chunk"},
          {<<3, 1::32, 0::32, 1::32, 0>>, "invalid_chunk"},
          {<<2, 1::32, 0::32, 1025::32, 0>>, "message_too_large"},
          {<<2, 1::32, 0::32, 65::32, 0::size(65 * 8)>>, "message_too_large"},
          {second, "invalid_chunk"},
          {<<2, 1::32, 0::32, 1::32, 255>>, "invalid_message"}
        ] do
      ref = push(writer, "transfer_chunk", {:binary, message})
      assert_reply ref, :error, %{reason: ^reason}
    end

    ref = push(writer, "save_update", {:binary, data})
    assert_reply ref, :error, %{reason: "message_too_large"}
    ref = push(writer, "transfer_chunk", {:binary, first})
    assert_reply ref, :ok, %{saved: false}
    Process.sleep(125)
    ref = push(writer, "transfer_chunk", {:binary, second})
    assert_reply ref, :error, %{reason: "invalid_chunk"}
    assert log_count(room) == 0
    refute_push "yjs_chunk", _
    {:ok, owner} = Documents.open(room)
    assert Process.alive?(owner)
    stop(owner, [writer])
  end

  @tag capture_log: true
  test "a rejected final write never acknowledges or broadcasts a partial or mutated document" do
    {room, writer} = join_room()
    {_room, reader} = join_room(room)
    Process.unlink(writer.channel_pid)
    Process.unlink(reader.channel_pid)
    {:ok, owner} = Documents.open(room)
    monitor = Process.monitor(owner)

    Repo.query!(
      "ALTER TABLE document_updates ADD CONSTRAINT reject_chunk_write CHECK (false) NOT VALID"
    )

    chunks = upload_chunks(update(String.duplicate("x", 300)))

    for chunk <- Enum.drop(chunks, -1) do
      ref = push(writer, "transfer_chunk", {:binary, chunk})
      assert_reply ref, :ok, %{saved: false}
    end

    ref = push(writer, "transfer_chunk", {:binary, List.last(chunks)})
    assert_reply ref, :error, %{reason: "storage_unavailable"}
    assert_receive {:DOWN, ^monitor, :process, ^owner, :storage_unavailable}
    assert log_count(room) == 0
    refute_push "yjs_chunk", _
  end

  test "chunks consume the existing per-channel budget and partial transfers do not survive rejoin" do
    limits = Application.fetch_env!(:synixir, :collaboration_limits)

    Application.put_env(
      :synixir,
      :collaboration_limits,
      Keyword.merge(limits, message_burst: 2, messages_per_second: 1)
    )

    {room, writer} = join_room()
    [first, second, third | _] = upload_chunks(update(String.duplicate("x", 300)))

    for chunk <- [first, second] do
      ref = push(writer, "transfer_chunk", {:binary, chunk})
      assert_reply ref, :ok, %{saved: false}
    end

    ref = push(writer, "transfer_chunk", {:binary, third})
    assert_reply ref, :error, %{reason: "rate_limited"}
    Process.unlink(writer.channel_pid)
    ref = leave(writer)
    assert_reply ref, :ok
    {_room, rejoined} = join_room(room)
    ref = push(rejoined, "transfer_chunk", {:binary, second})
    assert_reply ref, :error, %{reason: "invalid_chunk"}
    assert log_count(room) == 0
    {:ok, owner} = Documents.open(room)
    stop(owner, [rejoined])
  end

  defp receive_message(parts \\ [], expected \\ 0) do
    assert_push "yjs_chunk", {:binary, <<0, _id::32, offset::32, total::32, data::binary>>}
    assert offset == expected
    assert byte_size(data) <= 64
    parts = [data | parts]

    if offset + byte_size(data) == total do
      parts |> Enum.reverse() |> IO.iodata_to_binary()
    else
      receive_message(parts, offset + byte_size(data))
    end
  end

  defp upload_chunks(data),
    do: for(<<0, rest::binary>> <- ChunkTransfer.chunks(data, 1, 64), do: <<2, rest::binary>>)

  defp join_room(room \\ "chunk-#{Ecto.UUID.generate()}") do
    {:ok, token} = RoomAccess.issue(room, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})

    {:ok, %{transfer: %{chunk_bytes: 64}}, joined} =
      subscribe_and_join(socket, "document:#{room}", %{"token" => token, "chunked_sync" => 1})

    {room, joined}
  end

  defp update(value) do
    doc = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(doc, "content"), 0, value)
    {:ok, update} = Yex.encode_state_as_update(doc)
    update
  end

  defp text(update) do
    doc = Yex.Doc.new()
    :ok = Yex.apply_update(doc, update)
    Yex.Text.to_string(Yex.Doc.get_text(doc, "content"))
  end

  defp log_count(room),
    do: Repo.aggregate(from(u in "document_updates", where: u.room_id == ^room), :count)

  defp stop(owner, channels) do
    for channel <- channels, do: Process.unlink(channel.channel_pid)
    Process.exit(owner, :kill)
  end
end

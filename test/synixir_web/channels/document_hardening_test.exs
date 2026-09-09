defmodule SynixirWeb.DocumentHardeningTest do
  use Synixir.DataCase, async: false
  import Phoenix.ChannelTest
  alias Synixir.Documents
  alias SynixirWeb.DocumentSocket
  @endpoint SynixirWeb.Endpoint

  setup do
    handler_id = "channel-test-#{Ecto.UUID.generate()}"

    events = [
      [:synixir, :channel, :join],
      [:synixir, :channel, :message],
      [:synixir, :document, :save],
      [:synixir, :document, :restore]
    ]

    :ok = :telemetry.attach_many(handler_id, events, &__MODULE__.record_event/4, self())
    on_exit(fn -> :telemetry.detach(handler_id) end)
    :ok
  end

  def record_event(event, measurements, metadata, target) do
    send(target, {:telemetry, event, measurements, metadata})
  end

  test "malformed or oversized messages cannot change or restart a healthy room" do
    {room_id, joined} = join_room()
    {:ok, owner} = Documents.open(room_id)
    limit = Application.fetch_env!(:synixir, :collaboration_limits)[:max_message_bytes]
    oversized = :binary.copy(<<0>>, limit + 1)
    too_much_awareness = Yex.Sync.message_encode!({:awareness, :binary.copy(<<0>>, 16_385)})

    for {event, payload, reason} <- [
          {"save_update", {:binary, <<255>>}, "invalid_message"},
          {"yjs", {:binary, <<>>}, "invalid_message"},
          {"yjs", {:binary, <<0, 2, 1, 255>>}, "invalid_message"},
          {"yjs_sync", {:binary, <<0, 0, 1, 255>>}, "invalid_message"},
          {"yjs", {:binary, <<1, 1, 255>>}, "invalid_message"},
          {"save_update", {:binary, oversized}, "message_too_large"},
          {"yjs", {:binary, oversized}, "message_too_large"},
          {"yjs", {:binary, too_much_awareness}, "message_too_large"},
          {"save_update", %{"text" => "not binary"}, "unsupported_message"},
          {"unknown", %{}, "unsupported_message"}
        ] do
      ref = push(joined, event, payload)
      assert_reply ref, :error, %{reason: ^reason}
      assert {:ok, ^owner} = Documents.open(room_id)
      assert_receive {:telemetry, [:synixir, :channel, :message], _, metadata}
      assert Map.keys(metadata) |> Enum.sort() == [:event, :result]
    end

    client = Yex.Doc.new()
    {:ok, awareness} = Yex.Awareness.new(client)

    for state <- [
          %{"cursor" => %{"anchor" => "bad", "head" => %{}}},
          %{"user" => %{"name" => []}}
        ] do
      :ok = Yex.Awareness.set_local_state(awareness, state)
      {:ok, update} = Yex.Awareness.encode_update(awareness, [Yex.Awareness.client_id(awareness)])
      ref = push(joined, "yjs", {:binary, Yex.Sync.message_encode!({:awareness, update})})
      assert_reply ref, :error, %{reason: "invalid_message"}
    end

    refute_push "yjs", _message

    assert Repo.aggregate(from(u in "document_updates", where: u.room_id == ^room_id), :count) ==
             0

    :ok = Yex.Text.insert(Yex.Doc.get_text(client, "content"), 0, "Still works")
    {:ok, update} = Yex.encode_state_as_update(client)
    ref = push(joined, "save_update", {:binary, update})
    assert_reply ref, :ok, %{saved: true}
    assert {:ok, ^owner} = Documents.open(room_id)
  end

  test "message bursts are rejected per channel without blocking another collaborator" do
    previous = Application.fetch_env!(:synixir, :collaboration_limits)

    Application.put_env(
      :synixir,
      :collaboration_limits,
      Keyword.merge(previous, message_burst: 2, messages_per_second: 1)
    )

    on_exit(fn -> Application.put_env(:synixir, :collaboration_limits, previous) end)
    {room_id, writer} = join_room()
    {:ok, token} = issue_room_grant(room_id, "reader")
    {:ok, socket} = connect(DocumentSocket, %{})
    {:ok, _, reader} = subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})

    for _ <- 1..2 do
      ref = push(writer, "yjs", {:binary, <<3>>})
      assert_reply ref, :ok, %{saved: false}
    end

    ref = push(writer, "yjs", {:binary, <<3>>})
    assert_reply ref, :error, %{reason: "rate_limited"}
    assert_receive {:telemetry, [:synixir, :channel, :message], _, %{result: :rate_limited}}
    ref = push(reader, "yjs", {:binary, <<3>>})
    assert_reply ref, :ok, %{saved: false}
  end

  @tag capture_log: true
  test "telemetry reports durable writes, duplicates and recovery without content or identity" do
    {room_id, socket} = join_room()

    assert_receive {:telemetry, [:synixir, :channel, :join], %{count: 1, duration: duration},
                    %{result: :ok}}

    assert duration >= 0

    assert_receive {:telemetry, [:synixir, :document, :restore], %{updates: 0, bytes: 0},
                    %{result: :ok}}

    doc = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(doc, "content"), 0, "Private text")
    {:ok, update} = Yex.encode_state_as_update(doc)

    for inserted <- [1, 0] do
      ref = push(socket, "save_update", {:binary, update})
      assert_reply ref, :ok, %{saved: true}
      assert_receive {:telemetry, [:synixir, :document, :save], measurements, metadata}
      assert Map.keys(metadata) == [:result]
      assert metadata.result == :ok
      assert measurements.inserted == inserted
      assert measurements.bytes == byte_size(update)
    end

    {:ok, owner} = Documents.open(room_id)
    Process.unlink(socket.channel_pid)
    monitor = Process.monitor(owner)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}
    assert {:ok, _} = Documents.open(room_id)

    assert_receive {:telemetry, [:synixir, :document, :restore], %{updates: 1, bytes: bytes},
                    %{result: :ok}}

    assert bytes == byte_size(update)
  end

  @tag capture_log: true
  test "storage failures report failure measurements and never a successful insert" do
    {_room_id, socket} = join_room()
    Process.unlink(socket.channel_pid)

    Repo.query!(
      "ALTER TABLE document_updates ADD CONSTRAINT reject_test_writes CHECK (false) NOT VALID"
    )

    ref = push(socket, "save_update", {:binary, <<0, 0>>})
    assert_reply ref, :error, %{reason: "storage_unavailable"}

    assert_receive {:telemetry, [:synixir, :document, :save], %{inserted: 0},
                    %{result: :storage_unavailable}}

    Repo.query!("ALTER TABLE document_updates RENAME TO unavailable_document_updates")
    assert {:error, _} = Documents.open("cannot-load-#{Ecto.UUID.generate()}")

    assert_receive {:telemetry, [:synixir, :document, :restore], _,
                    %{result: :storage_unavailable}}
  end

  defp join_room do
    room_id = "hardening-#{Ecto.UUID.generate()}"
    {:ok, token} = issue_room_grant(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})
    {:ok, _, joined} = subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})
    {room_id, joined}
  end
end

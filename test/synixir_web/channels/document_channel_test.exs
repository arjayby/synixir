defmodule SynixirWeb.DocumentChannelTest do
  use Synixir.DataCase, async: false

  import Phoenix.ChannelTest

  alias SynixirWeb.DocumentSocket

  @endpoint SynixirWeb.Endpoint

  test "a storage read failure refuses the join instead of serving an empty document" do
    room_id = "load-failed-#{Ecto.UUID.generate()}"
    {:ok, token} = issue_room_grant(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})
    Repo.query!("ALTER TABLE document_updates RENAME TO unavailable_document_updates")

    assert {:error, %{reason: "document_unavailable"}} =
             subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})
  end

  @tag capture_log: true
  test "a rejected database write is neither acknowledged as saved nor broadcast" do
    room_id = "failed-#{Ecto.UUID.generate()}"
    {:ok, token} = issue_room_grant(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})
    {:ok, _, writer} = subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})
    {:ok, _, reader} = subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})
    Process.unlink(writer.channel_pid)
    Process.unlink(reader.channel_pid)
    {:ok, owner} = Synixir.Documents.open(room_id)
    monitor = Process.monitor(owner)

    # This constraint exists only inside the sandbox transaction and rejects
    # the actual PostgreSQL insert, without replacing the storage implementation.
    Repo.query!(
      "ALTER TABLE document_updates ADD CONSTRAINT reject_test_writes CHECK (false) NOT VALID"
    )

    client = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(client, "content"), 0, "Must not be saved")
    {:ok, update} = Yex.encode_state_as_update(client)
    ref = push(writer, "save_update", {:binary, update})

    assert_reply ref, :error, %{reason: "storage_unavailable"}
    assert_receive {:DOWN, ^monitor, :process, ^owner, :storage_unavailable}
    refute_push "yjs", _message
  end

  test "an out-of-order update survives a crash and merges when its dependency arrives" do
    room_id = "pending-#{Ecto.UUID.generate()}"
    client = Yex.Doc.new()
    text = Yex.Doc.get_text(client, "content")
    :ok = Yex.Text.insert(text, 0, "A")
    {:ok, first} = Yex.encode_state_as_update(client)
    {:ok, vector} = Yex.encode_state_vector(client)
    :ok = Yex.Text.insert(text, 1, "B")
    {:ok, second} = Yex.encode_state_as_update(client, vector)

    {:ok, owner} = Synixir.Documents.open(room_id)
    assert {:ok, [], true} = Synixir.Documents.save_update(owner, second)
    monitor = Process.monitor(owner)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}

    {:ok, recovered} = Synixir.Documents.open(room_id)
    assert {:ok, [], true} = Synixir.Documents.save_update(recovered, first)
    assert {:ok, [], true} = Synixir.Documents.save_update(recovered, second)
    empty_client = Yex.Doc.new()
    {:ok, step1} = Yex.Sync.get_sync_step1(empty_client)
    message = Yex.Sync.message_encode!({:sync, step1})
    assert {:ok, [reply | _], false} = Synixir.Documents.sync(recovered, message)
    {:ok, {:sync, {:sync_step2, update}}} = Yex.Sync.message_decode(reply)
    :ok = Yex.apply_update(empty_client, update)
    assert Yex.Text.to_string(Yex.Doc.get_text(empty_client, "content")) == "AB"
  end

  test "an acknowledged edit is recovered after the document process is killed" do
    room_id = "saved-#{Ecto.UUID.generate()}"
    {:ok, token} = issue_room_grant(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})
    {:ok, _, joined} = subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})

    client = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(client, "content"), 0, "Saved text 👋")
    {:ok, update} = Yex.encode_state_as_update(client)
    ref = push(joined, "save_update", {:binary, update})
    assert_reply ref, :ok, %{saved: true}

    # Neither client state nor a graceful shutdown may supply the recovered text.
    Process.unlink(joined.channel_pid)
    left = leave(joined)
    assert_reply left, :ok
    {:ok, owner} = Synixir.Documents.open(room_id)
    monitor = Process.monitor(owner)
    Process.exit(owner, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :killed}

    {:ok, _, recovered} = subscribe_and_join(socket, "document:#{room_id}", %{"token" => token})
    empty_client = Yex.Doc.new()
    {:ok, step1} = Yex.Sync.get_sync_step1(empty_client)
    push(recovered, "yjs_sync", {:binary, Yex.Sync.message_encode!({:sync, step1})})
    assert_push "yjs", {:binary, message}
    assert {:ok, {:sync, {:sync_step2, restored}}} = Yex.Sync.message_decode(message)
    :ok = Yex.apply_update(empty_client, restored)
    assert Yex.Text.to_string(Yex.Doc.get_text(empty_client, "content")) == "Saved text 👋"
  end

  test "missing, tampered, expired and invalid grants cannot join a room" do
    room_id = "denied-#{System.unique_integer([:positive])}"
    {:ok, token} = issue_room_grant(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})

    # A correctly signed but old grant tests expiry without waiting.
    expired =
      Phoenix.Token.sign(
        @endpoint,
        "synixir room access v1",
        %{
          room_id: room_id,
          user_id: "alice"
        },
        signed_at: System.system_time(:second) - 901
      )

    invalid_claims =
      Phoenix.Token.sign(@endpoint, "synixir room access v1", %{
        room_id: room_id,
        user_id: ""
      })

    for params <- [
          %{},
          %{"token" => nil},
          %{"token" => %{}},
          %{"token" => token <> "tampered"},
          %{"token" => expired},
          %{"token" => invalid_claims}
        ] do
      assert {:error, %{reason: "unauthorized"}} =
               subscribe_and_join(socket, "document:#{room_id}", params)
    end
  end

  test "a room token authorizes its room and supplies the signed user identity" do
    room_id = "access-#{System.unique_integer([:positive])}"
    {:ok, token} = issue_room_grant(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})

    assert {:ok, _, joined} =
             subscribe_and_join(socket, "document:#{room_id}", %{
               "token" => token,
               "user_id" => "mallory"
             })

    assert {:ok, _id} = Ecto.UUID.cast(joined.assigns.user_id)
    assert joined.assigns.user_id != "mallory"

    assert {:error, %{reason: "unauthorized"}} =
             subscribe_and_join(socket, "document:another-room", %{"token" => token})
  end
end

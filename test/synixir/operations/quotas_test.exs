defmodule Synixir.QuotasTest do
  use Synixir.DataCase, async: false
  import Phoenix.ChannelTest
  alias Synixir.{Admission, Documents, Documents.Store, RoomAccess}
  @endpoint SynixirWeb.Endpoint

  setup do
    previous = Application.fetch_env!(:synixir, :quotas)
    on_exit(fn -> Application.put_env(:synixir, :quotas, previous) end)
    :ok
  end

  defp limit(overrides) do
    Application.put_env(
      :synixir,
      :quotas,
      Keyword.merge(Application.fetch_env!(:synixir, :quotas), overrides)
    )
  end

  test "admission enforces account, room and node limits and releases a crashed owner" do
    limit(channels_per_node: 2, channels_per_room: 1, channels_per_account: 1)
    parent = self()

    first =
      spawn(fn ->
        send(parent, {:reserved, Admission.reserve("one", "alice")})

        receive do
          :stop -> :ok
        end
      end)

    on_exit(fn -> if Process.alive?(first), do: Process.exit(first, :kill) end)
    assert_receive {:reserved, :ok}
    assert {:error, :room_channel_quota} = Admission.reserve("one", "bob")
    assert {:error, :account_channel_quota} = Admission.reserve("two", "alice")
    assert :ok = Admission.reserve("two", "bob")
    assert :ok = Admission.reserve("two", "bob")
    assert Admission.count() == 2
    task = Task.async(fn -> Admission.reserve("three", "carol") end)
    assert {:error, :node_channel_quota} = Task.await(task)
    :ok = Admission.release()
    monitor = Process.monitor(first)
    Process.exit(first, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^first, :killed}
    # Synchronize with the admission monitor rather than guessing timer delays.
    wait_empty()
    assert :ok = Admission.reserve("one", "alice")
    :ok = Admission.release()
  end

  defp wait_empty(attempts \\ 50)
  defp wait_empty(0), do: flunk("admission did not release the exited owner")

  defp wait_empty(attempts) do
    if Admission.count() != 0 do
      Process.sleep(2)
      wait_empty(attempts - 1)
    end
  end

  test "failed joins release reservations and quota rejection never opens a document" do
    room = "quota-#{Ecto.UUID.generate()}"
    {:ok, token} = issue_room_grant(room)
    {:ok, socket} = connect(SynixirWeb.DocumentSocket, %{})
    {:ok, _, joined} = subscribe_and_join(socket, "document:#{room}", %{"token" => token})
    limit(channels_per_node: Admission.count())
    other = "denied-#{Ecto.UUID.generate()}"
    {:ok, other_token} = issue_room_grant(other)

    assert {:error, %{reason: "node_channel_quota"}} =
             subscribe_and_join(socket, "document:#{other}", %{"token" => other_token})

    assert Registry.lookup(Synixir.Documents.Registry, other) == []
    Process.unlink(joined.channel_pid)
    ref = leave(joined)
    assert_reply ref, :ok
    wait_empty()
    Repo.query!("ALTER TABLE document_updates RENAME TO unavailable_document_updates")

    assert {:error, %{reason: "document_unavailable"}} =
             subscribe_and_join(socket, "document:#{other}", %{"token" => other_token})

    wait_empty()
  end

  test "room creation and owner promotion enforce the same persistent account quota" do
    limit(rooms_per_account: 1)
    actor = account_fixture()
    other = account_fixture()
    room = "owned-#{Ecto.UUID.generate()}"
    second = "other-#{Ecto.UUID.generate()}"
    assert {:ok, _} = RoomAccess.create_room(room, actor.hash)
    assert {:error, :room_quota} = RoomAccess.create_room(second, actor.hash)
    assert {:ok, _} = RoomAccess.create_room(second, other.hash)

    assert {:error, :room_quota} =
             RoomAccess.set_member(second, other.hash, actor.user.username, "owner")

    assert {:ok, _} = RoomAccess.set_member(second, other.hash, actor.user.username, "editor")
    assert {:ok, _} = RoomAccess.set_member(room, actor.hash, actor.user.username, "owner")
  end

  test "storage quota rejects before live apply and duplicate acknowledgement remains safe" do
    room = "storage-quota-#{Ecto.UUID.generate()}"
    {:ok, token} = issue_room_grant(room)
    {:ok, grant} = RoomAccess.verify(room, token)
    client = Yex.Doc.new()
    text = Yex.Doc.get_text(client, "content")
    :ok = Yex.Text.insert(text, 0, "saved")
    {:ok, first} = Yex.encode_state_as_update(client)
    {:ok, vector} = Yex.encode_state_vector(client)
    :ok = Yex.Text.insert(text, 5, " refused")
    {:ok, second} = Yex.encode_state_as_update(client, vector)
    limit(stored_bytes_per_room: byte_size(first))
    {:ok, doc} = Documents.open(room)
    assert {:ok, [], true} = Documents.authenticated(doc, :update, first, grant)
    assert {:ok, [], true} = Documents.authenticated(doc, :update, first, grant)
    assert {:error, :storage_quota} = Documents.authenticated(doc, :update, second, grant)
    assert Process.alive?(doc)

    assert {:error, :storage_quota} =
             Store.append_authorized(room, second, grant, fn ->
               flunk("quota applied a rejected update")
             end)

    restored = Yex.Doc.new()
    Store.restore(room, restored)
    assert Yex.Text.to_string(Yex.Doc.get_text(restored, "content")) == "saved"
    empty = Yex.Doc.new()
    {:ok, step1} = Yex.Sync.get_sync_step1(empty)
    {:ok, [reply | _], false} = Documents.sync(doc, Yex.Sync.message_encode!({:sync, step1}))
    {:ok, {:sync, {:sync_step2, data}}} = Yex.Sync.message_decode(reply)
    :ok = Yex.apply_update(empty, data)
    assert Yex.Text.to_string(Yex.Doc.get_text(empty, "content")) == "saved"
  end
end

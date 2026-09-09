defmodule Synixir.RoomPermissionsTest do
  use Synixir.DataCase, async: false
  import Phoenix.ChannelTest
  alias Synixir.{Accounts, Documents, RoomAccess}
  alias SynixirWeb.{DocumentSocket, ChunkTransfer}
  @endpoint SynixirWeb.Endpoint

  setup do
    owner = account_fixture("owner")
    editor = account_fixture("editor")
    viewer = account_fixture("viewer")
    room = "permissions-#{Ecto.UUID.generate()}"
    {:ok, _} = RoomAccess.create_room(room, owner.hash)
    {:ok, _} = RoomAccess.set_member(room, owner.hash, editor.user.username, "editor")
    {:ok, _} = RoomAccess.set_member(room, owner.hash, viewer.user.username, "viewer")
    %{owner: owner, editor: editor, viewer: viewer, room: room}
  end

  test "membership is required and only owners manage roles; the last owner is protected", ctx do
    outsider = account_fixture("outsider")
    assert {:error, :unauthorized} = RoomAccess.issue(ctx.room, outsider.hash)

    assert {:error, :forbidden} =
             RoomAccess.set_member(ctx.room, ctx.editor.hash, outsider.user.username, "owner")

    assert {:error, :forbidden} = RoomAccess.members(ctx.room, ctx.viewer.hash)

    assert {:error, :last_owner} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.owner.user.username, nil)

    assert {:error, :invalid_role} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.editor.user.username, "admin")

    assert {:ok, _} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.editor.user.username, "owner")

    assert {:ok, _} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.owner.user.username, "viewer")

    assert {:ok, _} = RoomAccess.members(ctx.room, ctx.editor.hash)
  end

  test "viewers receive sync without reverse upload and cannot save through any event", ctx do
    {viewer, _grant} = join_actor(ctx.room, ctx.viewer)
    {:ok, doc} = Documents.open(ctx.room)
    data = update("Only editors may save this")
    {:ok, sync} = Yex.Sync.get_update(data)
    message = Yex.Sync.message_encode!({:sync, sync})

    for {event, payload} <- [{"save_update", data}, {"yjs", message}, {"yjs_sync", message}] do
      ref = push(viewer, event, {:binary, payload})
      assert_reply ref, :error, %{reason: "read_only"}
    end

    [<<0, rest::binary>>] = ChunkTransfer.chunks(data, 1, 256)
    ref = push(viewer, "transfer_chunk", {:binary, <<2, rest::binary>>})
    assert_reply ref, :error, %{reason: "read_only"}
    assert log_count(ctx.room) == 0
    refute_push "yjs", _

    {:ok, step1} = Yex.Sync.get_sync_step1(Yex.Doc.new())
    ref = push(viewer, "yjs_sync", {:binary, Yex.Sync.message_encode!({:sync, step1})})
    assert_reply ref, :ok, %{saved: false}
    assert_push "yjs", {:binary, reply}
    assert {:ok, {:sync, {:sync_step2, _}}} = Yex.Sync.message_decode(reply)
    refute_push "yjs", _
    ref = push(viewer, "yjs", {:binary, <<3>>})
    assert_reply ref, :ok, %{saved: false}
    Process.unlink(viewer.channel_pid)
    Process.exit(doc, :kill)
  end

  test "revocation closes active sessions, discards partial uploads and never revives old tokens",
       ctx do
    {channel, grant} = join_actor(ctx.room, ctx.editor)
    Process.unlink(channel.channel_pid)
    monitor = Process.monitor(channel.channel_pid)
    [<<0, rest::binary>> | _] = ChunkTransfer.chunks(update(String.duplicate("x", 200)), 1, 64)
    ref = push(channel, "transfer_chunk", {:binary, <<2, rest::binary>>})
    assert_reply ref, :ok, %{saved: false}

    assert {:ok, _} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.editor.user.username, nil)

    assert_push "access_revoked", _
    assert_receive {:DOWN, ^monitor, :process, _, :normal}
    assert log_count(ctx.room) == 0
    assert {:error, :unauthorized} = RoomAccess.with_access(grant, :write, fn _ -> :bad end)

    assert {:ok, _} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.editor.user.username, "editor")

    assert {:error, :unauthorized} = RoomAccess.with_access(grant, :write, fn _ -> :bad end)
    assert {:ok, _} = RoomAccess.issue(ctx.room, ctx.editor.hash)
  end

  test "queued writes are authorized inside the document worker after membership changes", ctx do
    grant = grant(ctx.room, ctx.editor)
    {:ok, doc} = Documents.open(ctx.room)
    :ok = :sys.suspend(doc)
    caller = Task.async(fn -> Documents.authenticated(doc, :update, update("denied"), grant) end)
    wait_for_call(doc)

    assert {:ok, _} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.editor.user.username, "viewer")

    :ok = :sys.resume(doc)
    assert {:error, :unauthorized} = Task.await(caller)
    assert log_count(ctx.room) == 0
    assert Process.alive?(doc)
    Process.exit(doc, :kill)
  end

  test "logout rejects a queued write and invalidates every grant for that session", ctx do
    grant = grant(ctx.room, ctx.editor)
    {:ok, doc} = Documents.open(ctx.room)
    :ok = :sys.suspend(doc)
    caller = Task.async(fn -> Documents.authenticated(doc, :update, update("denied"), grant) end)
    wait_for_call(doc)
    assert :ok = Accounts.revoke_session(ctx.editor.raw)
    :ok = :sys.resume(doc)
    assert {:error, :unauthorized} = Task.await(caller)
    assert {:error, :unauthorized} = RoomAccess.issue(ctx.room, ctx.editor.hash)
    assert log_count(ctx.room) == 0
    Process.exit(doc, :kill)
  end

  test "queued document broadcasts are not delivered after revocation commits", ctx do
    {reader, _} = join_actor(ctx.room, ctx.viewer)
    Process.unlink(reader.channel_pid)
    :ok = :sys.suspend(reader.channel_pid)
    {:ok, doc} = Documents.open(ctx.room)

    assert {:ok, [], true} =
             Documents.authenticated(doc, :update, update("private"), grant(ctx.room, ctx.editor))

    assert {:ok, _} =
             RoomAccess.set_member(ctx.room, ctx.owner.hash, ctx.viewer.user.username, nil)

    :ok = :sys.resume(reader.channel_pid)
    assert_push "access_revoked", _
    refute_push "yjs", _
    refute_push "yjs_chunk", _
    Process.exit(doc, :kill)
  end

  test "expired sessions, wrong rooms and tokens from the old issuer fail closed", ctx do
    {:ok, %{token: token}} = RoomAccess.issue(ctx.room, ctx.editor.hash)
    assert {:error, :unauthorized} = RoomAccess.verify("other-room", token)

    old =
      Phoenix.Token.sign(@endpoint, "synixir room access v1", %{
        room_id: ctx.room,
        user_id: ctx.editor.user.id
      })

    assert {:error, :unauthorized} = RoomAccess.verify(ctx.room, old)

    Repo.update_all(from(s in "user_sessions", where: s.token_hash == ^ctx.editor.hash),
      set: [expires_at: DateTime.add(DateTime.utc_now(), -1)]
    )

    assert {:error, :unauthorized} = RoomAccess.verify(ctx.room, token)
  end

  test "creating a room cannot claim legacy saved data; adoption requires trusted code", ctx do
    legacy = "legacy-#{Ecto.UUID.generate()}"
    :ok = Documents.Store.append(legacy, update("existing document"))
    assert {:error, :room_unavailable} = RoomAccess.create_room(legacy, ctx.owner.hash)
    assert {:ok, _} = RoomAccess.adopt_legacy_room(legacy, ctx.owner.user)
    assert {:ok, _} = RoomAccess.issue(legacy, ctx.owner.hash)
    outsider = account_fixture("outsider")
    assert {:error, :unauthorized} = RoomAccess.issue(legacy, outsider.hash)
  end

  test "a grant cannot be reused against another document worker", ctx do
    other = "other-#{Ecto.UUID.generate()}"
    {:ok, doc} = Documents.open(other)

    assert {:error, :unauthorized} =
             Documents.authenticated(doc, :update, update("denied"), grant(ctx.room, ctx.editor))

    assert log_count(other) == 0
    Process.exit(doc, :kill)
  end

  defp grant(room, actor) do
    {:ok, %{token: token}} = RoomAccess.issue(room, actor.hash)
    {:ok, grant} = RoomAccess.verify(room, token)
    grant
  end

  defp join_actor(room, actor) do
    {:ok, %{token: token}} = RoomAccess.issue(room, actor.hash)
    {:ok, grant} = RoomAccess.verify(room, token)
    {:ok, socket} = connect(DocumentSocket, %{})

    {:ok, _, channel} =
      subscribe_and_join(socket, "document:#{room}", %{"token" => token, "chunked_sync" => 1})

    {channel, grant}
  end

  defp wait_for_call(doc, attempts \\ 100)
  defp wait_for_call(_doc, 0), do: flunk("call was not queued")

  defp wait_for_call(doc, attempts) do
    {:messages, messages} = Process.info(doc, :messages)

    if Enum.any?(messages, &match?({:"$gen_call", _, {:authorized, _, _}}, &1)) do
      :ok
    else
      Process.sleep(1)
      wait_for_call(doc, attempts - 1)
    end
  end

  defp log_count(room),
    do: Repo.aggregate(from(u in "document_updates", where: u.room_id == ^room), :count)

  defp update(value) do
    doc = Yex.Doc.new()
    :ok = Yex.Text.insert(Yex.Doc.get_text(doc, "content"), 0, value)
    {:ok, data} = Yex.encode_state_as_update(doc)
    data
  end
end

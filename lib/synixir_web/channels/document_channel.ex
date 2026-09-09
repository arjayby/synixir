defmodule SynixirWeb.DocumentChannel do
  @moduledoc """
  Authorizes room joins and exchanges binary Yjs messages with their documents.
  """

  use SynixirWeb, :channel

  alias Synixir.{Documents, RoomAccess}
  alias SynixirWeb.{MessageBudget, ChunkTransfer}
  alias Yex.Sync.SharedDoc

  @impl true
  def join(topic, params, socket) do
    started = System.monotonic_time()
    result = authorize_and_observe(topic, params, socket)

    outcome =
      case result do
        {:ok, _reply, _socket} -> :ok
        {:error, %{reason: "unauthorized"}} -> :unauthorized
        {:error, %{reason: "document_unavailable"}} -> :document_unavailable
        {:error, _} -> :quota_exceeded
      end

    :telemetry.execute(
      [:synixir, :channel, :join],
      %{duration: System.monotonic_time() - started, count: 1},
      %{result: outcome}
    )

    result
  end

  defp authorize_and_observe("document:" <> room_id, %{"token" => token} = params, socket) do
    with {:ok, grant} <- RoomAccess.verify(room_id, token),
         :ok <- Synixir.Admission.reserve(room_id, grant.user_id),
         :ok <-
           Phoenix.PubSub.subscribe(
             Synixir.PubSub,
             Synixir.Accounts.session_topic(grant.session_hash)
           ),
         :ok <-
           Phoenix.PubSub.subscribe(
             Synixir.PubSub,
             RoomAccess.member_topic(room_id, grant.user_id)
           ),
         {:ok, doc} <- Documents.open(room_id),
         :ok <- observe(doc),
         {:ok, _} <- RoomAccess.with_access(grant, :read, fn _ -> :ok end) do
      monitor = Process.monitor(doc)
      limits = Application.fetch_env!(:synixir, :collaboration_limits)
      budget = MessageBudget.new(limits, System.monotonic_time(:millisecond))

      chunked = params["chunked_sync"] == 1
      transfer_limits = ChunkTransfer.limits()

      reply =
        if chunked, do: %{transfer: transfer_limits, role: grant.role}, else: %{role: grant.role}

      Process.send_after(self(), :check_access, 30_000)

      {:ok, reply,
       assign(socket,
         doc: doc,
         doc_monitor: monitor,
         user_id: grant.user_id,
         grant: grant,
         message_budget: budget,
         chunked: chunked,
         transfer_limits: transfer_limits,
         transfer: nil,
         outgoing_id: 0
       )}
    else
      {:error, reason} ->
        Synixir.Admission.release()

        reason =
          if reason in [
               :unauthorized,
               :node_channel_quota,
               :room_channel_quota,
               :account_channel_quota,
               :document_quota
             ],
             do: reason,
             else: :document_unavailable

        {:error, %{reason: Atom.to_string(reason)}}
    end
  end

  defp authorize_and_observe(_topic, _params, _socket), do: {:error, %{reason: "unauthorized"}}

  defp observe(doc) do
    SharedDoc.observe(doc)
  catch
    :exit, _reason -> {:error, :document_unavailable}
  end

  @impl true
  def handle_in(event, payload, socket) do
    started = System.monotonic_time()

    {result, socket, budget} =
      case MessageBudget.consume(
             socket.assigns.message_budget,
             System.monotonic_time(:millisecond)
           ) do
        {:ok, budget} ->
          case RoomAccess.with_access(socket.assigns.grant, :read, fn _ -> :ok end) do
            {:ok, :ok} ->
              {result, socket} = dispatch_message(event, payload, socket)
              {result, socket, budget}

            {:error, _} ->
              {{:error, :unauthorized}, socket, budget}
          end

        {:error, reason, budget} ->
          {{:error, reason}, socket, budget}
      end

    bytes =
      case payload do
        {:binary, message} when is_binary(message) -> byte_size(message)
        _ -> 0
      end

    outcome =
      case result do
        {:ok, _, _} -> :ok
        {:error, reason} -> reason
      end

    :telemetry.execute(
      [:synixir, :channel, :message],
      %{duration: System.monotonic_time() - started, bytes: bytes, count: 1},
      %{
        event:
          if(event in ["yjs", "yjs_sync", "save_update", "transfer_chunk"],
            do: event,
            else: "unsupported"
          ),
        result: outcome
      }
    )

    protocol_reply(result, assign(socket, :message_budget, budget))
  rescue
    _ -> {:reply, {:error, %{reason: "unauthorized"}}, socket}
  end

  defp dispatch_message(
         "transfer_chunk",
         {:binary, message},
         %{assigns: %{chunked: true}} = socket
       ) do
    case ChunkTransfer.accept(socket.assigns.transfer, message, socket.assigns.transfer_limits) do
      {:more, partial} ->
        {{:ok, [], false}, assign(socket, :transfer, partial)}

      {:complete, event, data} ->
        kind = if event == "save_update", do: :update, else: :sync

        {Documents.authenticated(socket.assigns.doc, kind, data, socket.assigns.grant, :transfer),
         assign(socket, :transfer, nil)}

      {:error, reason} ->
        {{:error, reason}, assign(socket, :transfer, nil)}
    end
  end

  defp dispatch_message(event, payload, socket),
    do: {dispatch(event, payload, socket), socket}

  defp dispatch(event, {:binary, message}, socket) when event in ["yjs_sync", "yjs"] do
    Documents.authenticated(socket.assigns.doc, :sync, message, socket.assigns.grant)
  end

  defp dispatch("save_update", {:binary, update}, socket),
    do: Documents.authenticated(socket.assigns.doc, :update, update, socket.assigns.grant)

  defp dispatch(_event, _payload, _doc), do: {:error, :unsupported_message}

  defp protocol_reply(result, socket) do
    case result do
      {:ok, messages, saved} ->
        case authorized_messages(messages, socket) do
          {:ok, socket} -> {:reply, {:ok, %{saved: saved}}, socket}
          {:error, reason} -> {:reply, {:error, %{reason: Atom.to_string(reason)}}, socket}
        end

      {:error, reason} ->
        {:reply, {:error, %{reason: Atom.to_string(reason)}}, socket}
    end
  end

  @impl true
  def handle_info({:yjs, message, doc}, %{assigns: %{doc: doc}} = socket) do
    case authorized_messages([message], socket) do
      {:ok, socket} ->
        {:noreply, socket}

      {:error, :unauthorized} ->
        revoke(socket)

      {:error, _reason} ->
        push(socket, "sync_error", %{reason: "message_too_large"})
        {:stop, :normal, socket}
    end
  end

  def handle_info(:access_revoked, socket), do: revoke(socket)

  def handle_info(:check_access, socket) do
    case RoomAccess.with_access(socket.assigns.grant, :read, fn _ -> :ok end) do
      {:ok, :ok} ->
        Process.send_after(self(), :check_access, 30_000)
        {:noreply, socket}

      _ ->
        revoke(socket)
    end
  end

  def handle_info({:transfer_expired, token}, %{assigns: %{transfer: %{token: token}}} = socket),
    do: {:noreply, assign(socket, :transfer, nil)}

  def handle_info({:transfer_expired, _stale}, socket), do: {:noreply, socket}

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{assigns: %{doc_monitor: ref}} = socket) do
    {:stop, :document_unavailable, socket}
  end

  defp revoke(socket) do
    ChunkTransfer.discard(socket.assigns.transfer)
    push(socket, "access_revoked", %{reason: "access_changed"})
    {:stop, :normal, socket}
  end

  # Keep the read lock until pushes are queued. Already-sent bytes cannot be
  # recalled, but events waiting in this channel's mailbox are reauthorized.
  defp authorized_messages(messages, socket) do
    case RoomAccess.with_access(socket.assigns.grant, :read, fn _ ->
           send_messages(messages, socket)
         end) do
      {:ok, result} -> result
      {:error, _} -> {:error, :unauthorized}
    end
  rescue
    _ -> {:error, :unauthorized}
  end

  defp send_messages(messages, socket) do
    limits = socket.assigns.transfer_limits

    maximum =
      if socket.assigns.chunked, do: limits.max_transfer_bytes, else: limits.max_message_bytes

    if Enum.any?(messages, &(byte_size(&1) > maximum)) do
      {:error, :message_too_large}
    else
      socket =
        Enum.reduce(messages, socket, fn message, socket ->
          if byte_size(message) <= limits.max_message_bytes do
            push(socket, "yjs", {:binary, message})
            socket
          else
            id = rem(socket.assigns.outgoing_id + 1, 4_294_967_296)

            for chunk <- ChunkTransfer.chunks(message, id, limits.chunk_bytes),
                do: push(socket, "yjs_chunk", {:binary, chunk})

            assign(socket, :outgoing_id, id)
          end
        end)

      {:ok, socket}
    end
  end
end

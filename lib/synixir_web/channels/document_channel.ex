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
      end

    :telemetry.execute(
      [:synixir, :channel, :join],
      %{duration: System.monotonic_time() - started, count: 1},
      %{result: outcome}
    )

    result
  end

  defp authorize_and_observe("document:" <> room_id, %{"token" => token} = params, socket) do
    with {:ok, user_id} <- RoomAccess.verify(room_id, token),
         {:ok, doc} <- Documents.open(room_id),
         :ok <- observe(doc) do
      monitor = Process.monitor(doc)
      limits = Application.fetch_env!(:synixir, :collaboration_limits)
      budget = MessageBudget.new(limits, System.monotonic_time(:millisecond))

      chunked = params["chunked_sync"] == 1
      transfer_limits = ChunkTransfer.limits()
      reply = if chunked, do: %{transfer: transfer_limits}, else: %{}

      {:ok, reply,
       assign(socket,
         doc: doc,
         doc_monitor: monitor,
         user_id: user_id,
         message_budget: budget,
         chunked: chunked,
         transfer_limits: transfer_limits,
         transfer: nil,
         outgoing_id: 0
       )}
    else
      {:error, :unauthorized} -> {:error, %{reason: "unauthorized"}}
      {:error, _reason} -> {:error, %{reason: "document_unavailable"}}
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
          {result, socket} = dispatch_message(event, payload, socket)
          {result, socket, budget}

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
        {Documents.transfer(socket.assigns.doc, event, data), assign(socket, :transfer, nil)}

      {:error, reason} ->
        {{:error, reason}, assign(socket, :transfer, nil)}
    end
  end

  defp dispatch_message(event, payload, socket),
    do: {dispatch(event, payload, socket.assigns.doc), socket}

  defp dispatch(event, {:binary, message}, doc) when event in ["yjs_sync", "yjs"] do
    Documents.sync(doc, message)
  end

  defp dispatch("save_update", {:binary, update}, doc), do: Documents.save_update(doc, update)
  defp dispatch(_event, _payload, _doc), do: {:error, :unsupported_message}

  defp protocol_reply(result, socket) do
    case result do
      {:ok, messages, saved} ->
        case send_messages(messages, socket) do
          {:ok, socket} -> {:reply, {:ok, %{saved: saved}}, socket}
          {:error, reason} -> {:reply, {:error, %{reason: Atom.to_string(reason)}}, socket}
        end

      {:error, reason} ->
        {:reply, {:error, %{reason: Atom.to_string(reason)}}, socket}
    end
  end

  @impl true
  def handle_info({:yjs, message, doc}, %{assigns: %{doc: doc}} = socket) do
    case send_messages([message], socket) do
      {:ok, socket} ->
        {:noreply, socket}

      {:error, _reason} ->
        push(socket, "sync_error", %{reason: "message_too_large"})
        {:stop, :normal, socket}
    end
  end

  def handle_info({:transfer_expired, token}, %{assigns: %{transfer: %{token: token}}} = socket),
    do: {:noreply, assign(socket, :transfer, nil)}

  def handle_info({:transfer_expired, _stale}, socket), do: {:noreply, socket}

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{assigns: %{doc_monitor: ref}} = socket) do
    {:stop, :document_unavailable, socket}
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

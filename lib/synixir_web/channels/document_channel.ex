defmodule SynixirWeb.DocumentChannel do
  @moduledoc """
  Authorizes room joins and exchanges binary Yjs messages with their documents.
  """

  use SynixirWeb, :channel

  alias Synixir.{Documents, RoomAccess}
  alias SynixirWeb.MessageBudget
  alias Yex.Sync.SharedDoc

  @impl true
  def join(topic, params, socket) do
    started = System.monotonic_time()
    result = authorize_and_observe(topic, params, socket)

    outcome =
      case result do
        {:ok, _socket} -> :ok
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

  defp authorize_and_observe("document:" <> room_id, %{"token" => token}, socket) do
    with {:ok, user_id} <- RoomAccess.verify(room_id, token),
         {:ok, doc} <- Documents.open(room_id),
         :ok <- observe(doc) do
      monitor = Process.monitor(doc)
      limits = Application.fetch_env!(:synixir, :collaboration_limits)
      budget = MessageBudget.new(limits, System.monotonic_time(:millisecond))

      {:ok,
       assign(socket, doc: doc, doc_monitor: monitor, user_id: user_id, message_budget: budget)}
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

    {result, budget} =
      case MessageBudget.consume(
             socket.assigns.message_budget,
             System.monotonic_time(:millisecond)
           ) do
        {:ok, budget} -> {dispatch(event, payload, socket.assigns.doc), budget}
        {:error, reason, budget} -> {{:error, reason}, budget}
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
        event: if(event in ["yjs", "yjs_sync", "save_update"], do: event, else: "unsupported"),
        result: outcome
      }
    )

    protocol_reply(result, assign(socket, :message_budget, budget))
  end

  defp dispatch(event, {:binary, message}, doc) when event in ["yjs_sync", "yjs"] do
    Documents.sync(doc, message)
  end

  defp dispatch("save_update", {:binary, update}, doc), do: Documents.save_update(doc, update)
  defp dispatch(_event, _payload, _doc), do: {:error, :unsupported_message}

  defp protocol_reply(result, socket) do
    case result do
      {:ok, messages, saved} ->
        Enum.each(messages, &push(socket, "yjs", {:binary, &1}))
        {:reply, {:ok, %{saved: saved}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: Atom.to_string(reason)}}, socket}
    end
  end

  @impl true
  def handle_info({:yjs, message, doc}, %{assigns: %{doc: doc}} = socket) do
    push(socket, "yjs", {:binary, message})
    {:noreply, socket}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{assigns: %{doc_monitor: ref}} = socket) do
    {:stop, :document_unavailable, socket}
  end
end

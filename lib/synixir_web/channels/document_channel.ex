defmodule SynixirWeb.DocumentChannel do
  @moduledoc """
  Authorizes room joins and exchanges binary Yjs messages with their documents.
  """

  use SynixirWeb, :channel

  alias Synixir.{Documents, RoomAccess}
  alias Yex.Sync.SharedDoc

  @impl true
  def join("document:" <> room_id, %{"token" => token}, socket) do
    with {:ok, user_id} <- RoomAccess.verify(room_id, token),
         {:ok, doc} <- Documents.open(room_id) do
      :ok = SharedDoc.observe(doc)
      monitor = Process.monitor(doc)
      {:ok, assign(socket, doc: doc, doc_monitor: monitor, user_id: user_id)}
    else
      {:error, :unauthorized} -> {:error, %{reason: "unauthorized"}}
      {:error, _reason} -> {:error, %{reason: "document_unavailable"}}
    end
  end

  def join(_topic, _params, _socket), do: {:error, %{reason: "unauthorized"}}

  @impl true
  def handle_in(event, {:binary, message}, socket) when event in ["yjs_sync", "yjs"] do
    protocol_reply(Documents.sync(socket.assigns.doc, message), socket)
  end

  def handle_in("save_update", {:binary, update}, socket) do
    protocol_reply(Documents.save_update(socket.assigns.doc, update), socket)
  end

  def handle_in(_event, _payload, socket) do
    {:reply, {:error, %{reason: "unsupported_message"}}, socket}
  end

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

  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{assigns: %{doc_monitor: ref}} = socket) do
    {:stop, :document_unavailable, socket}
  end
end

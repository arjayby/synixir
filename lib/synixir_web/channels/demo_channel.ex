defmodule SynixirWeb.DemoChannel do
  @moduledoc """
  Exchanges binary Yjs sync messages with one in-memory Yex document.
  """

  use SynixirWeb, :channel

  alias Yex.Sync.SharedDoc

  @impl true
  def join("document:demo", _params, socket) do
    case Process.whereis(Synixir.DemoDocument) do
      nil ->
        {:error, %{reason: "document_unavailable"}}

      doc ->
        :ok = SharedDoc.observe(doc)
        monitor = Process.monitor(doc)
        {:ok, assign(socket, doc: doc, doc_monitor: monitor)}
    end
  end

  @impl true
  def handle_in(event, {:binary, message}, socket) when event in ["yjs_sync", "yjs"] do
    case SharedDoc.send_yjs_message(socket.assigns.doc, message) do
      :ok -> {:noreply, socket}
      {:error, _reason} -> {:reply, {:error, %{reason: "invalid_message"}}, socket}
    end
  end

  def handle_in(_event, _payload, socket) do
    {:reply, {:error, %{reason: "unsupported_message"}}, socket}
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

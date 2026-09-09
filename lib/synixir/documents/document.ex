defmodule Synixir.Documents.Document do
  @moduledoc false

  use Yex.DocServer

  alias Synixir.Documents.Store
  alias Yex.{Awareness, Sync}
  alias Yex.Sync.SharedDoc

  @impl true
  def init(opts, state) do
    {:ok, state} = SharedDoc.init(opts, state)
    :ok = Store.restore(state.assigns.doc_name, state.doc)
    {:ok, state}
  rescue
    _error -> {:stop, :storage_unavailable}
  end

  @impl true
  def handle_call({:sync, message}, {origin, _tag}, state) do
    case Sync.message_decode(message) do
      {:ok, {:sync, {kind, update}}} when kind in [:sync_step2, :sync_update] ->
        save(update, origin, state)

      {:ok, {:sync, {:sync_step1, vector}}} ->
        with {:ok, response} <- Sync.get_sync_step2(state.doc, vector),
             {:ok, request} <- Sync.get_sync_step1(state.doc) do
          replies = Enum.map([response, request], &Sync.message_encode!({:sync, &1}))
          {:reply, {:ok, replies ++ awareness_messages(state), false}, state}
        else
          _ -> {:reply, {:error, :invalid_message}, state}
        end

      {:ok, {:awareness, update}} ->
        case Awareness.apply_update(state.awareness, update, origin) do
          :ok -> {:reply, {:ok, [], false}, state}
          _ -> {:reply, {:error, :invalid_message}, state}
        end

      {:ok, :query_awareness} ->
        {:reply, {:ok, awareness_messages(state), false}, state}

      _ ->
        {:reply, {:error, :invalid_message}, state}
    end
  end

  def handle_call({:save_update, update}, {origin, _tag}, state) do
    save(update, origin, state)
  end

  def handle_call(message, from, state), do: SharedDoc.handle_call(message, from, state)

  defp save(update, origin, state) do
    case Sync.read_sync_step2(update, state.doc, origin) do
      :ok ->
        # Save the incoming bytes, including updates waiting for dependencies.
        # No queued update notification is broadcast until this call completes.
        :ok = Store.append(state.assigns.doc_name, update)
        {:reply, {:ok, [], true}, state}

      _ ->
        {:stop, :invalid_message, {:error, :invalid_message}, state}
    end
  rescue
    _error -> {:stop, :storage_unavailable, {:error, :storage_unavailable}, state}
  end

  defp awareness_messages(state) do
    case Awareness.get_client_ids(state.awareness) do
      [] ->
        []

      clients ->
        {:ok, update} = Awareness.encode_update(state.awareness, clients)
        [Sync.message_encode!({:awareness, update})]
    end
  end

  @impl true
  def handle_update_v1(_doc, _update, :restore, state), do: {:noreply, state}

  def handle_update_v1(doc, update, origin, state) do
    SharedDoc.handle_update_v1(doc, update, origin, state)
  end

  @impl true
  defdelegate handle_awareness_update(awareness, change, origin, state), to: SharedDoc

  @impl true
  defdelegate handle_info(message, state), to: SharedDoc
end

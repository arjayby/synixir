defmodule Synixir.Documents.Document do
  @moduledoc false

  use Yex.DocServer

  alias Synixir.Documents.Store
  alias Yex.{Awareness, Sync}
  alias Yex.Sync.SharedDoc

  @impl true
  def init(opts, state) do
    {:ok, state} = SharedDoc.init(opts, state)
    stats = Store.restore(state.assigns.doc_name, state.doc)

    state =
      assign(state,
        lifecycle: Application.fetch_env!(:synixir, :document_lifecycle),
        log_updates: stats.updates,
        log_bytes: stats.bytes,
        idle_timer: nil,
        compact_pending: false
      )

    {:ok, state |> reset_idle() |> schedule_compaction()}
  rescue
    _error -> {:stop, :storage_unavailable}
  end

  @impl true
  def handle_call({:validated, message}, {origin, _tag}, state) do
    state = reset_idle(state)

    case message do
      {:update, update} ->
        save(update, origin, state)

      {:sync_step1, vector} ->
        with {:ok, response} <- Sync.get_sync_step2(state.doc, vector),
             {:ok, request} <- Sync.get_sync_step1(state.doc) do
          replies = Enum.map([response, request], &Sync.message_encode!({:sync, &1}))
          {:reply, {:ok, replies ++ awareness_messages(state), false}, state}
        else
          _ -> {:reply, {:error, :invalid_message}, state}
        end

      {:awareness, update} ->
        case Awareness.apply_update(state.awareness, update, origin) do
          :ok -> {:reply, {:ok, [], false}, state}
          _ -> {:reply, {:error, :invalid_message}, state}
        end

      :query_awareness ->
        {:reply, {:ok, awareness_messages(state), false}, state}

      _ ->
        {:reply, {:error, :invalid_message}, state}
    end
  end

  def handle_call(:compact, _from, state) do
    {result, state} = compact(state)
    {:reply, result, state}
  end

  def handle_call({:observe, _client} = message, from, state) do
    {:reply, :ok, state} = SharedDoc.handle_call(message, from, state)
    {:reply, :ok, reset_idle(state)}
  end

  def handle_call({:unobserve, _client} = message, from, state) do
    {:reply, :ok, state, _timeout} = SharedDoc.handle_call(message, from, state)
    {:reply, :ok, reset_idle(state)}
  end

  def handle_call(message, from, state), do: SharedDoc.handle_call(message, from, state)

  defp save(update, origin, state) do
    case Sync.read_sync_step2(update, state.doc, origin) do
      :ok ->
        # Save the incoming bytes, including updates waiting for dependencies.
        # No queued update notification is broadcast until this call completes.
        :ok = Store.append(state.assigns.doc_name, update)

        state =
          assign(state,
            log_updates: state.assigns.log_updates + 1,
            log_bytes: state.assigns.log_bytes + byte_size(update)
          )

        {:reply, {:ok, [], true}, schedule_compaction(state)}

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
  def handle_info({:idle, token}, %{assigns: %{idle_timer: {_timer, token}}} = state) do
    if map_size(state.assigns.observer_process) == 0 do
      :telemetry.execute([:synixir, :document, :unload], %{count: 1}, %{})
      {:stop, :normal, state}
    else
      {:noreply, reset_idle(state)}
    end
  end

  def handle_info({:idle, _stale}, state), do: {:noreply, state}

  def handle_info(:compact, state) do
    {_result, state} = compact(assign(state, :compact_pending, false))
    {:noreply, state}
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason} = message, state) do
    {:noreply, state} = SharedDoc.handle_info(message, state)
    {:noreply, reset_idle(state)}
  end

  def handle_info(message, state), do: SharedDoc.handle_info(message, state)

  defp reset_idle(state) do
    if state.assigns.idle_timer, do: Process.cancel_timer(elem(state.assigns.idle_timer, 0))

    timer =
      if map_size(state.assigns.observer_process) == 0 do
        token = make_ref()

        {Process.send_after(self(), {:idle, token}, state.assigns.lifecycle[:idle_timeout_ms]),
         token}
      end

    assign(state, :idle_timer, timer)
  end

  defp schedule_compaction(state) do
    if not state.assigns.compact_pending and
         (state.assigns.log_updates >= state.assigns.lifecycle[:compact_after_updates] or
            state.assigns.log_bytes >= state.assigns.lifecycle[:compact_after_bytes]) do
      send(self(), :compact)
      assign(state, :compact_pending, true)
    else
      state
    end
  end

  defp compact(state) do
    :ok = Store.compact(state.assigns.doc_name)
    {:ok, assign(state, log_updates: 0, log_bytes: 0)}
  rescue
    # The transaction leaves the old snapshot and raw log intact. Compaction
    # failure cannot undo an acknowledged write, and is retried on later saves.
    _error -> {{:error, :storage_unavailable}, state}
  end
end

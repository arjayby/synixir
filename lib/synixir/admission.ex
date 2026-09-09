defmodule Synixir.Admission do
  @moduledoc "Node-local admission for authenticated room channels, released on process exit."
  use GenServer

  def start_link(_opts), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  def reserve(room, user), do: GenServer.call(__MODULE__, {:reserve, self(), room, user})
  def release, do: GenServer.call(__MODULE__, {:release, self()})
  def count(timeout \\ 5000), do: GenServer.call(__MODULE__, :count, timeout)

  @impl true
  def init(_), do: {:ok, %{owners: %{}, rooms: %{}, users: %{}}}

  @impl true
  def handle_call({:reserve, pid, room, user}, _from, state) do
    limits = Application.fetch_env!(:synixir, :quotas)

    cond do
      Map.has_key?(state.owners, pid) ->
        {:reply, :ok, state}

      map_size(state.owners) >= limits[:channels_per_node] ->
        reject(:node_channel_quota, state)

      Map.get(state.rooms, room, 0) >= limits[:channels_per_room] ->
        reject(:room_channel_quota, state)

      Map.get(state.users, user, 0) >= limits[:channels_per_account] ->
        reject(:account_channel_quota, state)

      true ->
        ref = Process.monitor(pid)

        state = %{
          owners: Map.put(state.owners, pid, {ref, room, user}),
          rooms: Map.update(state.rooms, room, 1, &(&1 + 1)),
          users: Map.update(state.users, user, 1, &(&1 + 1))
        }

        {:reply, :ok, state}
    end
  end

  def handle_call({:release, pid}, _from, state), do: {:reply, :ok, remove(state, pid)}
  def handle_call(:count, _from, state), do: {:reply, map_size(state.owners), state}

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state),
    do: {:noreply, remove(state, pid)}

  defp remove(state, pid) do
    case Map.pop(state.owners, pid) do
      {nil, _} ->
        state

      {{ref, room, user}, owners} ->
        Process.demonitor(ref, [:flush])

        %{
          owners: owners,
          rooms: decrement(state.rooms, room),
          users: decrement(state.users, user)
        }
    end
  end

  defp decrement(counts, key) do
    if counts[key] == 1, do: Map.delete(counts, key), else: Map.update!(counts, key, &(&1 - 1))
  end

  defp reject(reason, state) do
    :telemetry.execute([:synixir, :quota, :rejected], %{count: 1}, %{reason: reason})
    {:reply, {:error, reason}, state}
  end
end

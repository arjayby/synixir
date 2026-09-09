defmodule Synixir.AuthRateLimit do
  @moduledoc false
  use GenServer
  @max_buckets 10_000

  def start_link(_opts), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  def allow?(ip), do: GenServer.call(__MODULE__, {:allow, ip})
  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:allow, ip}, _from, state) do
    now = System.monotonic_time(:millisecond)
    limits = Application.fetch_env!(:synixir, :authentication_limits)
    state = Map.reject(state, fn {_key, {_count, until}} -> until <= now end)
    {count, until} = Map.get(state, ip, {0, now + limits[:window_ms]})

    if count >= limits[:attempts] or
         (not Map.has_key?(state, ip) and map_size(state) >= @max_buckets) do
      {:reply, false, state}
    else
      {:reply, true, Map.put(state, ip, {count + 1, until})}
    end
  end
end

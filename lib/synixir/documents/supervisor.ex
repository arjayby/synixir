defmodule Synixir.Documents.Supervisor do
  @moduledoc false

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children = [
      {Registry, keys: :unique, name: Synixir.Documents.Registry},
      {DynamicSupervisor,
       strategy: :one_for_one,
       name: Synixir.Documents.Workers,
       max_children: Application.fetch_env!(:synixir, :quotas)[:active_documents]}
    ]

    # Losing the registry also restarts its documents, so no unregistered
    # document can keep running alongside a newly created owner for its room.
    Supervisor.init(children, strategy: :rest_for_one)
  end
end

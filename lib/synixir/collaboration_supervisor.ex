defmodule Synixir.CollaborationSupervisor do
  @moduledoc false
  use Supervisor

  def start_link(opts), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_opts) do
    # A lost admission registry must close the channels whose reservations it
    # tracked. Restarting it alone would permit admission above the limits.
    Supervisor.init(
      [Synixir.Admission, Synixir.Documents.Supervisor, SynixirWeb.Endpoint],
      strategy: :rest_for_one
    )
  end
end

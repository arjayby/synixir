defmodule SynixirWeb.Telemetry do
  use Supervisor
  import Telemetry.Metrics

  def start_link(arg) do
    Supervisor.start_link(__MODULE__, arg, name: __MODULE__)
  end

  @impl true
  def init(_arg) do
    children = [
      # Telemetry poller will execute the given period measurements
      # every 10_000ms. Learn more here: https://telemetry-metrics.hexdocs.pm
      {:telemetry_poller, measurements: periodic_measurements(), period: 10_000}
      # Add reporters as children of your supervision tree.
      # {Telemetry.Metrics.ConsoleReporter, metrics: metrics()}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  def metrics do
    [
      # Collaboration measurements use bounded labels, without room or user IDs.
      counter("synixir.channel.join.count", tags: [:result]),
      summary("synixir.channel.join.duration", unit: {:native, :millisecond}, tags: [:result]),
      counter("synixir.channel.message.count", tags: [:event, :result]),
      summary("synixir.channel.message.duration",
        unit: {:native, :millisecond},
        tags: [:event, :result]
      ),
      summary("synixir.channel.message.bytes", tags: [:event, :result]),
      counter("synixir.document.save.count", tags: [:result]),
      sum("synixir.document.save.inserted"),
      summary("synixir.document.save.duration", unit: {:native, :millisecond}, tags: [:result]),
      summary("synixir.document.save.bytes", tags: [:result]),
      counter("synixir.document.restore.count", tags: [:result]),
      summary("synixir.document.restore.duration", unit: {:native, :millisecond}, tags: [:result]),
      summary("synixir.document.restore.updates", tags: [:result]),
      summary("synixir.document.restore.bytes", tags: [:result]),
      counter("synixir.document.compact.count", tags: [:result]),
      summary("synixir.document.compact.duration", unit: {:native, :millisecond}, tags: [:result]),
      summary("synixir.document.compact.updates", tags: [:result]),
      summary("synixir.document.compact.bytes", tags: [:result]),
      counter("synixir.document.unload.count"),
      last_value("synixir.documents.active"),

      # Phoenix Metrics
      summary("phoenix.endpoint.start.system_time",
        unit: {:native, :millisecond}
      ),
      summary("phoenix.endpoint.stop.duration",
        unit: {:native, :millisecond}
      ),
      summary("phoenix.router_dispatch.start.system_time",
        tags: [:route],
        unit: {:native, :millisecond}
      ),
      summary("phoenix.router_dispatch.exception.duration",
        tags: [:route],
        unit: {:native, :millisecond}
      ),
      summary("phoenix.router_dispatch.stop.duration",
        tags: [:route],
        unit: {:native, :millisecond}
      ),
      summary("phoenix.socket_connected.duration",
        unit: {:native, :millisecond}
      ),
      sum("phoenix.socket_drain.count"),
      summary("phoenix.channel_joined.duration",
        unit: {:native, :millisecond}
      ),
      summary("phoenix.channel_handled_in.duration",
        tags: [:event],
        unit: {:native, :millisecond}
      ),

      # Database Metrics
      summary("synixir.repo.query.total_time",
        unit: {:native, :millisecond},
        description: "The sum of the other measurements"
      ),
      summary("synixir.repo.query.decode_time",
        unit: {:native, :millisecond},
        description: "The time spent decoding the data received from the database"
      ),
      summary("synixir.repo.query.query_time",
        unit: {:native, :millisecond},
        description: "The time spent executing the query"
      ),
      summary("synixir.repo.query.queue_time",
        unit: {:native, :millisecond},
        description: "The time spent waiting for a database connection"
      ),
      summary("synixir.repo.query.idle_time",
        unit: {:native, :millisecond},
        description:
          "The time the connection spent waiting before being checked out for the query"
      ),

      # VM Metrics
      summary("vm.memory.total", unit: {:byte, :kilobyte}),
      summary("vm.total_run_queue_lengths.total"),
      summary("vm.total_run_queue_lengths.cpu"),
      summary("vm.total_run_queue_lengths.io")
    ]
  end

  defp periodic_measurements do
    [
      {__MODULE__, :count_documents, []}
    ]
  end

  def count_documents do
    if Process.whereis(Synixir.Documents.Registry) do
      :telemetry.execute(
        [:synixir, :documents],
        %{active: Registry.count(Synixir.Documents.Registry)},
        %{}
      )
    end
  end
end

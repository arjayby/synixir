defmodule Synixir.Operations.Metrics do
  @moduledoc "Prometheus metrics with bounded labels, seconds, and bytes."
  import Telemetry.Metrics
  @latency_buckets [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15]
  @results ~w(ok unauthorized read_only invalid_message invalid_chunk message_too_large
    rate_limited unsupported_message storage_unavailable document_unavailable unavailable
    quota_exceeded node_channel_quota room_channel_quota account_channel_quota document_quota room_quota storage_quota)
  @events ~w(yjs yjs_sync save_update transfer_chunk unsupported)
  @reasons ~w(node_channel_quota room_channel_quota account_channel_quota document_quota room_quota storage_quota)

  def definitions do
    storage =
      for operation <- [:save, :restore, :compact],
          metric <- [
            counter("synixir.document.#{operation}.total",
              description: "Document #{operation} requests, including retries and failures.",
              event_name: [:synixir, :document, operation],
              measurement: :count,
              tags: [:result],
              tag_values: &labels/1
            ),
            latency(
              "synixir.document.#{operation}.duration.seconds",
              [:synixir, :document, operation],
              :duration
            ),
            sum("synixir.document.#{operation}.bytes.total",
              description: "Bytes reported by document #{operation} requests.",
              event_name: [:synixir, :document, operation],
              measurement: :bytes,
              tags: [:result],
              tag_values: &labels/1
            )
          ],
          do: metric

    storage ++
      [
        counter("synixir.channel.joins.total",
          description: "Room channel join attempts by outcome.",
          event_name: [:synixir, :channel, :join],
          measurement: :count,
          tags: [:result],
          tag_values: &labels/1
        ),
        counter("synixir.channel.messages.total",
          description: "Incoming room channel messages by bounded event and outcome.",
          event_name: [:synixir, :channel, :message],
          measurement: :count,
          tags: [:event, :result],
          tag_values: &labels/1
        ),
        counter("synixir.quota.rejections.total",
          description: "Rejected operations by quota reason.",
          event_name: [:synixir, :quota, :rejected],
          measurement: :count,
          tags: [:reason],
          tag_values: &labels/1
        ),
        counter("synixir.readiness.checks.total",
          description: "Readiness probes by outcome, including authenticated metric scrapes.",
          event_name: [:synixir, :health, :ready],
          measurement: :count,
          tags: [:result],
          tag_values: &labels/1
        ),
        last_value("synixir.ready",
          event_name: [:synixir, :health, :ready],
          measurement: :ready,
          description: "One when the latest readiness probe succeeded, refreshed on every scrape."
        ),
        latency("synixir.database.query.seconds", [:synixir, :repo, :query], :query_time, []),
        latency("synixir.database.queue.seconds", [:synixir, :repo, :query], :queue_time, []),
        last_value("synixir.documents.active",
          description: "Resident document workers, including idle rooms.",
          event_name: [:synixir, :operations],
          measurement: :documents
        ),
        last_value("synixir.channels.active",
          description: "Admitted room channels on this node.",
          event_name: [:synixir, :operations],
          measurement: :channels
        ),
        last_value("synixir.vm.memory.bytes",
          description:
            "Total BEAM memory reported by erlang memory, excluding untracked native allocations.",
          event_name: [:synixir, :operations],
          measurement: :memory
        ),
        last_value("synixir.vm.run.queue",
          description: "Processes waiting to run on BEAM schedulers.",
          event_name: [:synixir, :operations],
          measurement: :run_queue
        ),
        last_value("synixir.document.limit",
          description: "Configured resident document limit on this node.",
          event_name: [:synixir, :operations],
          measurement: :document_limit
        ),
        last_value("synixir.channel.limit",
          description: "Configured joined channel limit on this node.",
          event_name: [:synixir, :operations],
          measurement: :channel_limit
        )
      ]
  end

  defp latency(name, event, measurement, tags \\ [:result]) do
    distribution(name,
      description: "Elapsed #{measurement} for #{Enum.join(event, " ")} in seconds.",
      event_name: event,
      measurement: measurement,
      unit: {:native, :second},
      tags: tags,
      tag_values: &labels/1,
      reporter_options: [buckets: @latency_buckets]
    )
  end

  defp labels(metadata) do
    %{
      result: bounded(metadata[:result], @results),
      event: bounded(metadata[:event], @events),
      reason: bounded(metadata[:reason], @reasons)
    }
  end

  defp bounded(value, allowed) when is_atom(value) or is_binary(value) do
    value = to_string(value)
    if value in allowed, do: value, else: "other"
  end

  defp bounded(_, _), do: "other"

  def sample do
    limits = Application.fetch_env!(:synixir, :quotas)

    :telemetry.execute(
      [:synixir, :operations],
      %{
        documents: Registry.count(Synixir.Documents.Registry),
        channels: Synixir.Admission.count(100),
        memory: :erlang.memory(:total),
        run_queue: :erlang.statistics(:run_queue),
        document_limit: limits[:active_documents],
        channel_limit: limits[:channels_per_node]
      },
      %{}
    )
  rescue
    ArgumentError -> :ok
  catch
    :exit, _ -> :ok
  end
end

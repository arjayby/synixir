# Runs only in the disposable drill database, using independent committed connections.
defmodule Synixir.LimitsCheck do
  alias Synixir.{Accounts, Admission, Documents, Documents.Store, Repo, RoomAccess}

  def run do
    database = System.fetch_env!("SYNIXIR_OPERATIONS_DATABASE")
    true = Repo.config()[:database] == database
    previous = Application.fetch_env!(:synixir, :quotas)

    Application.put_env(
      :synixir,
      :quotas,
      Keyword.merge(previous, rooms_per_account: 1, active_documents: 1)
    )

    {:ok, user} =
      Accounts.register(%{username: "quota_race", password: "isolated limits fixture password"})

    hash = user |> Accounts.create_session() |> then(&:crypto.hash(:sha256, &1))

    results =
      1..16
      |> Task.async_stream(fn n -> RoomAccess.create_room("limit_#{n}", hash) end,
        max_concurrency: 16
      )
      |> Enum.map(fn {:ok, result} -> result end)

    1 = Enum.count(results, &match?({:ok, _}, &1))
    15 = Enum.count(results, &match?({:error, :room_quota}, &1))

    updates =
      for n <- 1..16 do
        doc = Yex.Doc.new()
        :ok = Yex.Text.insert(Yex.Doc.get_text(doc, "content"), 0, "writer-#{n}")
        {:ok, update} = Yex.encode_state_as_update(doc)
        update
      end

    maximum = updates |> Enum.map(&byte_size/1) |> Enum.max()

    Application.put_env(
      :synixir,
      :quotas,
      Keyword.put(Application.fetch_env!(:synixir, :quotas), :stored_bytes_per_room, maximum)
    )

    results =
      updates
      |> Task.async_stream(&Store.append("limit_bytes", &1), max_concurrency: 16)
      |> Enum.map(fn {:ok, result} -> result end)

    1 = Enum.count(results, &(&1 == :ok))
    15 = Enum.count(results, &(&1 == {:error, :storage_quota}))

    # Apply the resident-worker limit at supervisor startup, as a real config change would.
    :ok = Supervisor.terminate_child(Synixir.CollaborationSupervisor, Documents.Supervisor)
    {:ok, _} = Supervisor.restart_child(Synixir.CollaborationSupervisor, Documents.Supervisor)
    {:ok, doc} = Documents.open("limit_active")
    {:ok, ^doc} = Documents.open("limit_active")
    {:error, :document_quota} = Documents.open("limit_extra")
    :ok = DynamicSupervisor.terminate_child(Documents.Workers, doc)
    {:ok, replacement} = Documents.open("limit_extra")

    # Forgetting reservations must also terminate document/endpoint processes.
    endpoint = Process.whereis(SynixirWeb.Endpoint)
    admission = Process.whereis(Admission)
    Process.exit(admission, :kill)

    await(fn ->
      new_endpoint = Process.whereis(SynixirWeb.Endpoint)

      is_pid(new_endpoint) and new_endpoint != endpoint and
        is_pid(Process.whereis(Admission)) and not Process.alive?(replacement)
    end)

    0 = Admission.count()

    # A suspended checkout process demonstrates why query timeout alone is insufficient.
    %{pid: pool} = Ecto.Adapter.lookup_meta(Repo)
    :ok = :sys.suspend(pool)

    try do
      started = System.monotonic_time(:millisecond)
      false = Synixir.Operations.Health.ready?()
      elapsed = System.monotonic_time(:millisecond) - started
      true = elapsed >= 900 and elapsed < 2000
      [] = Task.Supervisor.children(Synixir.HealthTasks)
    after
      :ok = :sys.resume(pool)
    end

    true = Synixir.Operations.Health.ready?()
    admission = Process.whereis(Admission)
    :ok = :sys.suspend(admission)

    try do
      false = Synixir.Operations.Health.ready?()
      started = System.monotonic_time(:millisecond)
      :ok = Synixir.Operations.Metrics.sample()
      true = System.monotonic_time(:millisecond) - started < 500
    after
      :ok = :sys.resume(admission)
    end

    true = Synixir.Operations.Health.ready?()
    Application.put_env(:synixir, :quotas, previous)

    IO.puts(
      "OPERATIONS_RESULT=" <>
        Jason.encode!(%{
          concurrent_quotas: true,
          resident_limit: true,
          restart_cleanup: true,
          readiness_deadline: true
        })
    )
  end

  defp await(fun, remaining \\ 100)
  defp await(_, 0), do: raise("supervision recovery timed out")

  defp await(fun, remaining) do
    unless fun.() do
      Process.sleep(20)
      await(fun, remaining - 1)
    end
  end
end

Synixir.LimitsCheck.run()

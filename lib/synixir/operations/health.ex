defmodule Synixir.Operations.Health do
  @moduledoc "Bounded database and collaboration readiness checks."
  @deadline_ms 1000

  def ready? do
    started = System.monotonic_time()
    ready = check()

    :telemetry.execute(
      [:synixir, :health, :ready],
      %{count: 1, ready: if(ready, do: 1, else: 0), duration: System.monotonic_time() - started},
      %{result: if(ready, do: :ok, else: :unavailable)}
    )

    ready
  end

  defp check do
    task = Task.Supervisor.async_nolink(Synixir.HealthTasks, &probe/0)

    case Task.yield(task, @deadline_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, true} -> true
      _ -> false
    end
  rescue
    _ -> false
  catch
    :exit, _ -> false
  end

  defp probe do
    # LIMIT 0 checks required tables/columns without scanning application data.
    result =
      Synixir.Repo.query(
        """
        SELECT u.id, s.token_hash, r.id, m.version, d.digest, p.digest
        FROM users u, user_sessions s, rooms r, room_memberships m,
             document_updates d, document_snapshots p LIMIT 0
        """,
        [],
        timeout: 750,
        queue: false,
        log: false
      )

    match?({:ok, _}, result) and Synixir.Admission.count() >= 0 and
      is_pid(Process.whereis(Synixir.Documents.Workers))
  rescue
    _ -> false
  catch
    :exit, _ -> false
  end
end

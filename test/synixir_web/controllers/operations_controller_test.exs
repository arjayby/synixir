defmodule SynixirWeb.OperationsControllerTest do
  use SynixirWeb.ConnCase, async: false

  setup do
    previous = Application.get_env(:synixir, :metrics_token)
    on_exit(fn -> Application.put_env(:synixir, :metrics_token, previous) end)
    :ok
  end

  test "liveness needs no database while readiness checks the schema", %{conn: conn} do
    assert %{"status" => "ok"} = conn |> get("/health/ready") |> json_response(200)
    Synixir.Repo.query!("ALTER TABLE document_snapshots RENAME TO unavailable_snapshots")
    assert %{"status" => "ok"} = build_conn() |> get("/health/live") |> json_response(200)
    result = build_conn() |> get("/health/ready")
    assert %{"status" => "unavailable"} = json_response(result, 503)
    refute result.resp_body =~ "snapshot"
    assert get_resp_header(result, "cache-control") == ["no-store"]
    assert get_resp_header(result, "set-cookie") == []
  end

  test "metrics fail closed and expose bounded labels and histogram units" do
    Application.put_env(:synixir, :metrics_token, nil)
    assert build_conn() |> get("/metrics") |> response(404) == ""
    token = String.duplicate("test", 8)
    Application.put_env(:synixir, :metrics_token, token)
    assert build_conn() |> get("/metrics") |> response(401) == ""

    assert build_conn()
           |> put_req_header("authorization", "Bearer wrong")
           |> get("/metrics")
           |> response(401) == ""

    :telemetry.execute([:synixir, :channel, :message], %{count: 1, duration: 0, bytes: 1}, %{
      event: "private-room-secret",
      result: "private-account-secret"
    })

    :telemetry.execute(
      [:synixir, :document, :save],
      %{
        count: 1,
        duration: System.convert_time_unit(100, :millisecond, :native),
        bytes: 2,
        inserted: 1
      },
      %{result: :ok}
    )

    conn = build_conn() |> put_req_header("authorization", "Bearer " <> token) |> get("/metrics")
    body = response(conn, 200)
    assert body =~ "synixir_channel_messages_total{event=\"other\",result=\"other\"}"
    assert body =~ "synixir_document_save_duration_seconds_bucket"
    assert body =~ "synixir_ready 1"
    assert body =~ "synixir_vm_memory_bytes"
    refute body =~ "private-"
    refute body =~ token
    assert get_resp_header(conn, "content-type") == ["text/plain; version=0.0.4; charset=utf-8"]
  end

  test "readiness rejects when the bounded probe pool is saturated" do
    tasks =
      for _ <- 1..4,
          do:
            Task.Supervisor.async_nolink(Synixir.HealthTasks, fn -> Process.sleep(:infinity) end)

    try do
      started = System.monotonic_time(:millisecond)
      assert build_conn() |> get("/health/ready") |> response(503)
      assert System.monotonic_time(:millisecond) - started < 500
    after
      Enum.each(tasks, &Task.shutdown(&1, :brutal_kill))
    end
  end
end

defmodule SynixirWeb.OperationsController do
  use SynixirWeb, :controller

  def live(conn, _), do: conn |> no_cache() |> json(%{status: "ok"})

  def ready(conn, _) do
    if Synixir.Operations.Health.ready?(),
      do: conn |> no_cache() |> json(%{status: "ok"}),
      else: conn |> no_cache() |> put_status(503) |> json(%{status: "unavailable"})
  end

  def metrics(conn, _) do
    token = Application.get_env(:synixir, :metrics_token)
    supplied = get_req_header(conn, "authorization")

    cond do
      is_nil(token) ->
        conn |> no_cache() |> send_resp(404, "")

      authorized?(supplied, token) ->
        Synixir.Operations.Health.ready?()
        Synixir.Operations.Metrics.sample()

        conn
        |> no_cache()
        |> put_resp_header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        |> send_resp(200, TelemetryMetricsPrometheus.Core.scrape(:synixir_metrics))

      true ->
        conn |> no_cache() |> send_resp(401, "")
    end
  end

  defp authorized?(["Bearer " <> supplied], token),
    do: Plug.Crypto.secure_compare(supplied, token)

  defp authorized?(_, _), do: false
  defp no_cache(conn), do: put_resp_header(conn, "cache-control", "no-store")
end

defmodule SynixirWeb.ClientController do
  use SynixirWeb, :controller

  def index(conn, _), do: page(conn, "index.html")
  def settings(conn, _), do: page(conn, "sdk.html")

  defp page(conn, name) do
    path = Application.app_dir(:synixir, "priv/static/" <> name)
    conn = put_resp_header(conn, "cache-control", "no-store")

    if File.regular?(path),
      do: conn |> put_resp_content_type("text/html") |> send_file(200, path),
      else: send_resp(conn, 404, "Client assets are not built. Use the Vite development server.")
  end
end

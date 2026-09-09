defmodule SynixirWeb.CurrentAccount do
  import Plug.Conn
  def init(opts), do: opts

  def call(conn, _opts) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> assign(:account, Synixir.Accounts.session(get_session(conn, :user_token)))
  end
end

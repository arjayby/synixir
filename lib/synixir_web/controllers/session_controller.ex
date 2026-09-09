defmodule SynixirWeb.SessionController do
  use SynixirWeb, :controller
  alias Synixir.Accounts

  def show(conn, _params) do
    json(conn, %{
      user: conn.assigns.account && conn.assigns.account.user,
      csrf_token: get_csrf_token()
    })
  end

  def register(conn, params) do
    if Synixir.AuthRateLimit.allow?(conn.remote_ip) do
      case Accounts.register(params) do
        {:ok, user} -> signed_in(conn, user)
        {:error, _changeset} -> conn |> put_status(422) |> json(%{error: "invalid_registration"})
      end
    else
      throttled(conn)
    end
  end

  def create(conn, params) do
    if Synixir.AuthRateLimit.allow?(conn.remote_ip) do
      case Accounts.authenticate(params["username"], params["password"]) do
        {:ok, user} -> signed_in(conn, user)
        {:error, _} -> conn |> put_status(401) |> json(%{error: "invalid_credentials"})
      end
    else
      throttled(conn)
    end
  end

  def delete(conn, _params) do
    Accounts.revoke_session(get_session(conn, :user_token))
    conn = renew(conn)
    json(conn, %{user: nil, csrf_token: get_csrf_token()})
  end

  defp signed_in(conn, user) do
    Accounts.revoke_session(get_session(conn, :user_token))
    raw = Accounts.create_session(user)
    conn = conn |> renew() |> put_session(:user_token, raw)
    json(conn, %{user: user, csrf_token: get_csrf_token()})
  end

  defp renew(conn) do
    delete_csrf_token()
    conn |> configure_session(renew: true) |> clear_session()
  end

  defp throttled(conn), do: conn |> put_status(429) |> json(%{error: "rate_limited"})
end

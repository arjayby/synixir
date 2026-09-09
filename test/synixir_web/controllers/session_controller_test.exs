defmodule SynixirWeb.SessionControllerTest do
  use SynixirWeb.ConnCase, async: false
  import Synixir.AccessHelpers

  test "registration, login and logout use revocable HttpOnly sessions and rotate CSRF", %{
    conn: conn
  } do
    conn = conn |> put_private(:plug_skip_csrf_protection, false) |> get("/api/session")
    %{"user" => nil, "csrf_token" => csrf} = json_response(conn, 200)

    conn =
      conn
      |> recycle()
      |> put_req_header("x-csrf-token", csrf)
      |> post("/api/accounts", %{
        username: "new_account",
        password: "a sufficiently long password"
      })

    %{"user" => %{"id" => id, "username" => "new_account"}, "csrf_token" => fresh_csrf} =
      json_response(conn, 200)

    refute fresh_csrf == csrf
    assert conn.resp_cookies["_synixir_key"].http_only
    refute json_response(conn, 200) |> Map.has_key?("password")
    raw = get_session(conn, :user_token)
    assert Synixir.Accounts.session(raw).user.id == id

    conn =
      conn |> recycle() |> put_req_header("x-csrf-token", fresh_csrf) |> delete("/api/session")

    assert %{"user" => nil} = json_response(conn, 200)
    assert Synixir.Accounts.session(raw) == nil
  end

  test "the old demo issuer is unavailable", %{conn: conn} do
    conn = post(conn, "/api/demo/room-token", %{room_id: "demo", user_id: "alice"})
    assert conn.status == 404
  end

  test "state-changing requests require CSRF and cannot forge a different identity", %{conn: conn} do
    actor = account_fixture()
    conn = conn |> put_private(:plug_skip_csrf_protection, false) |> get("/api/session")
    %{"csrf_token" => csrf} = json_response(conn, 200)

    assert_raise Plug.CSRFProtection.InvalidCSRFTokenError, fn ->
      conn
      |> recycle()
      |> put_private(:plug_skip_csrf_protection, false)
      |> post("/api/session", %{username: actor.user.username, password: actor.password})
    end

    conn =
      conn
      |> recycle()
      |> put_req_header("x-csrf-token", csrf)
      |> post("/api/session", %{
        username: actor.user.username,
        password: actor.password,
        user_id: "forged"
      })

    assert json_response(conn, 200)["user"]["id"] == actor.user.id
  end

  test "authentication attempts are throttled before repeated password checks", %{conn: conn} do
    previous = Application.fetch_env!(:synixir, :authentication_limits)
    Application.put_env(:synixir, :authentication_limits, attempts: 1, window_ms: 60_000)
    on_exit(fn -> Application.put_env(:synixir, :authentication_limits, previous) end)
    conn = %{conn | remote_ip: {127, 22, 11, 99}}
    failed = post(conn, "/api/session", %{username: "unknown", password: "incorrect password"})
    assert json_response(failed, 401) == %{"error" => "invalid_credentials"}
    limited = post(conn, "/api/session", %{username: "unknown", password: "incorrect password"})
    assert json_response(limited, 429) == %{"error" => "rate_limited"}
  end

  test "anonymous requests cannot create rooms or manage memberships", %{conn: conn} do
    for {method, path, body} <- [
          {:post, "/api/rooms", %{room_id: "anonymous"}},
          {:post, "/api/rooms/anonymous/token", %{user_id: "owner"}},
          {:put, "/api/rooms/anonymous/members/alice", %{role: "owner"}}
        ] do
      response = dispatch(conn, @endpoint, method, path, body)
      assert json_response(response, 401) == %{"error" => "unauthorized"}
    end
  end
end

defmodule SynixirWeb.DemoTokenControllerTest do
  use SynixirWeb.ConnCase, async: false

  test "the local example receives a non-cacheable grant for its requested room", %{conn: conn} do
    conn = post(conn, "/api/demo/room-token", %{room_id: "demo", user_id: "alice"})

    assert %{"token" => token} = json_response(conn, 200)
    assert get_resp_header(conn, "cache-control") == ["no-store"]
    assert {:ok, "alice"} = Synixir.RoomAccess.verify("demo", token)
    assert {:error, :unauthorized} = Synixir.RoomAccess.verify("other", token)
  end

  test "invalid identities cannot receive a demo token", %{conn: conn} do
    conn = post(conn, "/api/demo/room-token", %{room_id: "room/other", user_id: "alice"})

    assert %{"error" => "invalid_room_or_user"} = json_response(conn, 422)
  end

  test "the token endpoint refuses requests when the demo is disabled", %{conn: conn} do
    previous = Application.fetch_env!(:synixir, :collaboration_demo)
    Application.put_env(:synixir, :collaboration_demo, false)
    on_exit(fn -> Application.put_env(:synixir, :collaboration_demo, previous) end)

    conn = post(conn, "/api/demo/room-token", %{room_id: "demo", user_id: "alice"})

    assert %{"error" => "not_found"} = json_response(conn, 404)
  end
end

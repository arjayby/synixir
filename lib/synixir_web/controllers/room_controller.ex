defmodule SynixirWeb.RoomController do
  use SynixirWeb, :controller
  alias Synixir.RoomAccess
  plug :require_account

  def index(conn, _), do: respond(conn, RoomAccess.list_rooms(hash(conn)))

  def create(conn, params),
    do: respond(conn, RoomAccess.create_room(params["room_id"], hash(conn)))

  def token(conn, %{"room_id" => room}), do: respond(conn, RoomAccess.issue(room, hash(conn)))
  def members(conn, %{"room_id" => room}), do: respond(conn, RoomAccess.members(room, hash(conn)))

  def put_member(conn, %{"room_id" => room, "username" => username} = params),
    do:
      respond(conn, RoomAccess.set_member(room, hash(conn), username, params["role"] || :invalid))

  def delete_member(conn, %{"room_id" => room, "username" => username}),
    do: respond(conn, RoomAccess.set_member(room, hash(conn), username, nil))

  defp require_account(%{assigns: %{account: nil}} = conn, _),
    do: conn |> put_status(401) |> json(%{error: "unauthorized"}) |> halt()

  defp require_account(conn, _), do: conn
  defp hash(conn), do: conn.assigns.account.session_hash
  defp respond(conn, {:ok, data}), do: json(conn, %{data: data})

  defp respond(conn, {:error, reason}) do
    status =
      case reason do
        :unauthorized -> 403
        :forbidden -> 403
        :last_owner -> 409
        :room_unavailable -> 409
        :room_quota -> 429
        _ -> 422
      end

    conn |> put_status(status) |> json(%{error: Atom.to_string(reason)})
  end
end

defmodule SynixirWeb.DemoTokenController do
  @moduledoc """
  Grants room access for the local example without an account system.
  The route is absent when :collaboration_demo is disabled at compile time.
  """

  use SynixirWeb, :controller

  def create(conn, params) do
    if Application.get_env(:synixir, :collaboration_demo, false) do
      case Synixir.RoomAccess.issue(params["room_id"], params["user_id"]) do
        {:ok, token} ->
          conn
          |> put_resp_header("cache-control", "no-store")
          |> json(%{token: token})

        {:error, :invalid_claims} ->
          conn
          |> put_status(:unprocessable_entity)
          |> json(%{error: "invalid_room_or_user"})
      end
    else
      conn
      |> put_status(:not_found)
      |> json(%{error: "not_found"})
    end
  end
end

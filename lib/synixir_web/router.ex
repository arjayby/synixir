defmodule SynixirWeb.Router do
  use SynixirWeb, :router

  get "/", SynixirWeb.ClientController, :index
  get "/sdk.html", SynixirWeb.ClientController, :settings

  # Probe and scrape requests do not create sessions or need CSRF state.
  get "/health/live", SynixirWeb.OperationsController, :live
  get "/health/ready", SynixirWeb.OperationsController, :ready
  get "/metrics", SynixirWeb.OperationsController, :metrics

  pipeline :api do
    plug :accepts, ["json"]
    plug :fetch_session
    plug :protect_from_forgery
    plug SynixirWeb.CurrentAccount
  end

  scope "/api", SynixirWeb do
    pipe_through :api
    get "/session", SessionController, :show
    post "/session", SessionController, :create
    delete "/session", SessionController, :delete
    post "/accounts", SessionController, :register
    get "/rooms", RoomController, :index
    post "/rooms", RoomController, :create
    post "/rooms/:room_id/token", RoomController, :token
    get "/rooms/:room_id/members", RoomController, :members
    put "/rooms/:room_id/members/:username", RoomController, :put_member
    delete "/rooms/:room_id/members/:username", RoomController, :delete_member
  end
end

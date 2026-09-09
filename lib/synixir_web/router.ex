defmodule SynixirWeb.Router do
  use SynixirWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", SynixirWeb do
    pipe_through :api

    if Application.compile_env(:synixir, :collaboration_demo, false) do
      post "/demo/room-token", DemoTokenController, :create
    end
  end
end

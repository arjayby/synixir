defmodule SynixirWeb.Router do
  use SynixirWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", SynixirWeb do
    pipe_through :api
  end
end

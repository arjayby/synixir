defmodule Synixir.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      SynixirWeb.Telemetry,
      Synixir.Repo,
      {DNSCluster, query: Application.get_env(:synixir, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Synixir.PubSub},
      # Start a worker by calling: Synixir.Worker.start_link(arg)
      # {Synixir.Worker, arg},
      # Start to serve requests, typically the last entry
      SynixirWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Synixir.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    SynixirWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end

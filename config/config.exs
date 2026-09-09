# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :synixir,
  ecto_repos: [Synixir.Repo],
  collaboration_demo: false,
  generators: [timestamp_type: :utc_datetime]

config :synixir, :collaboration_limits,
  max_message_bytes: 1_048_576,
  max_awareness_bytes: 16_384,
  messages_per_second: 120,
  message_burst: 240

# Configure the endpoint
config :synixir, SynixirWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  http: [websocket_options: [max_fragmented_message_size: 2_097_152]],
  render_errors: [
    formats: [json: SynixirWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Synixir.PubSub,
  live_view: [signing_salt: "Jne5KTSf"]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

config :phoenix, :filter_parameters, ["password", "token"]

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"

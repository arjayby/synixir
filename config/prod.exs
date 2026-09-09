import Config

config :synixir, secure_session_cookie: true

# The app listener must be private to the HTTPS gateway, which overwrites the
# forwarded scheme. Internal probes and authenticated scrapes use that private network.
config :synixir, SynixirWeb.Endpoint,
  force_ssl: [
    rewrite_on: [:x_forwarded_proto, :x_forwarded_for],
    host: {SynixirWeb.Endpoint, :public_authority, []},
    exclude: [paths: ["/health/live", "/health/ready", "/metrics"]]
  ]

# Do not print debug messages in production
config :logger, level: :info

# Runtime production configuration, including reading
# of environment variables, is done on config/runtime.exs.

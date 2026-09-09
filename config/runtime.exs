import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/synixir start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :synixir, SynixirWeb.Endpoint, server: true
end

config :synixir, SynixirWeb.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))]

for {key, variable} <- [
      channels_per_node: "SYNIXIR_CHANNELS_PER_NODE",
      channels_per_room: "SYNIXIR_CHANNELS_PER_ROOM",
      channels_per_account: "SYNIXIR_CHANNELS_PER_ACCOUNT",
      active_documents: "SYNIXIR_ACTIVE_DOCUMENTS",
      rooms_per_account: "SYNIXIR_ROOMS_PER_ACCOUNT",
      stored_bytes_per_room: "SYNIXIR_STORED_BYTES_PER_ROOM"
    ] do
  if raw = System.get_env(variable) do
    value = String.to_integer(raw)
    if value <= 0, do: raise("#{variable} must be a positive integer")
    config :synixir, :quotas, [{key, value}]
  end
end

metrics_token = System.get_env("SYNIXIR_METRICS_TOKEN")

if metrics_token && byte_size(metrics_token) < 32,
  do: raise("SYNIXIR_METRICS_TOKEN must contain at least 32 bytes")

config :synixir, :metrics_token, metrics_token

# Operations fixtures must never fall back to the ordinary test database.
if database = System.get_env("SYNIXIR_OPERATIONS_DATABASE") do
  unless config_env() == :test and
           Regex.match?(~r/\Asynixir_(load|drill|restore)_[a-f0-9]{12}\z/, database),
         do: raise("Operations require MIX_ENV=test and an isolated database name")

  config :synixir, Synixir.Repo,
    database: database,
    hostname: System.get_env("PGHOST", "localhost"),
    port: String.to_integer(System.get_env("PGPORT", "5432")),
    username: System.get_env("PGUSER", "postgres"),
    password: System.get_env("PGPASSWORD", "postgres"),
    pool: DBConnection.ConnectionPool,
    pool_size: 10
end

if config_env() == :test and System.get_env("SYNIXIR_BROWSER_TEST") == "true" do
  # Browser tests use committed data across independent processes. Sandbox
  # retains connections for long-lived channels and documents, exhausting the
  # pool before later HTTP requests can run. Keep ExUnit's Sandbox separate.
  config :synixir, Synixir.Repo, pool: DBConnection.ConnectionPool, pool_size: 4
end

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  maybe_ipv6 = if System.get_env("ECTO_IPV6") in ~w(true 1), do: [:inet6], else: []

  config :synixir, Synixir.Repo,
    # ssl: true,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # For machines with several cores, consider starting multiple pools of `pool_size`
    # pool_count: 4,
    socket_options: maybe_ipv6

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :synixir, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :synixir, SynixirWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://bandit.hexdocs.pm/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0}
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :synixir, SynixirWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://plug.hexdocs.pm/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :synixir, SynixirWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.
end

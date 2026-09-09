import Config

config :synixir, collaboration_demo: true

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :synixir, Synixir.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "synixir_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :synixir, SynixirWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  check_origin: ["http://127.0.0.1:5174"],
  secret_key_base: "H/TYVgTsvGd8TC0BAwvfv/j2Ei0yOkbyvSiS4+55IYDtXWyBGPVSsimIL5CcaxLA",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true

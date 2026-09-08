# Synixir

Synixir is a planned Elixir/Phoenix collaboration.
Its intended scope includes realtime shared state, rooms, presence, and
collaborative editing, with PostgreSQL persistence through Ecto.

This repository contains the backend scaffold only. It includes the `:synixir`
OTP application, `Synixir` namespace, `Synixir.Repo`, and `SynixirWeb` endpoint
with an empty JSON API router. Collaboration features, authentication, product
schemas, frontend UI, a client SDK, and Yex integration are deferred.

## Local setup

- Elixir 1.18.3 and Erlang/OTP 27.3.3, pinned in `.tool-versions` for asdf.
- Hex and Rebar, available through `mix local.hex` and `mix local.rebar`.
- A running PostgreSQL server on `localhost:5432`.

The development and test configurations use username `postgres` and password
`postgres`. The role must be able to create databases. Adjust `config/dev.exs`
and `config/test.exs` if your local PostgreSQL settings differ.

From the project directory, run:

```sh
mix setup
mix phx.server
```

`mix setup` fetches dependencies, creates `synixir_dev`, and runs the empty
migration and seed steps. The server listens at [localhost:4000](http://localhost:4000).
There is no homepage or API route yet, so application requests return 404 once
the database is ready. Use `iex -S mix phx.server` for an interactive shell.

## Checks

```sh
mix format --check-formatted
mix compile --warnings-as-errors
mix test
```

`mix test` creates and migrates `synixir_test` before running the generated JSON
error tests. PostgreSQL is required. Test partitions append `MIX_TEST_PARTITION`
to the test database name.

Production runtime configuration is in `config/runtime.exs`. It reads
`DATABASE_URL` and `SECRET_KEY_BASE`, with optional `PHX_HOST`, `PORT`, and
`POOL_SIZE` settings. No infrastructure or deployment is included.

Generated with the [Phoenix 1.8.13 generator](https://phoenix.hexdocs.pm/1.8.13/Mix.Tasks.Phx.New.html),
using PostgreSQL and disabling HTML, assets, LiveDashboard, Gettext, and mailer
generation.

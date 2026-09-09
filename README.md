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
- Hex and Rebar, installed once with `mix local.hex --force` and
  `mix local.rebar --force`.
- Docker with Compose v2, through OrbStack or Docker Desktop.

With the asdf Erlang and Elixir plugins installed, `asdf install` installs the
versions in `.tool-versions`. Run the commands below from the project directory.

1. Start OrbStack or Docker Desktop. On macOS with OrbStack, use `orbctl start`.
2. Start PostgreSQL and wait for it to accept connections:

   ```sh
   docker compose up -d --wait db
   ```

   [compose.yaml](compose.yaml) runs PostgreSQL 17.11 at `localhost:5432` with
   username `postgres` and password `postgres`. These are local development
   credentials matching `config/dev.exs` and `config/test.exs`.

3. Fetch dependencies and create the development database:

   ```sh
   mix setup
   ```

   This creates `synixir_dev` and runs the empty migration and seed steps.

4. Run the checks below, then start Phoenix:

   ```sh
   mix phx.server
   ```

The server listens at [localhost:4000](http://localhost:4000).
There is no homepage or API route yet, so application requests return 404 once
the database is ready. Use `iex -S mix phx.server` for an interactive shell.

Use `docker compose ps` to check PostgreSQL and `docker compose logs db` to read
its logs. Stop it with `docker compose stop db`; start it again with the command
above. Database files live in the `synixir_postgres_data` Docker volume and
survive container removal with `docker compose down`.

If another PostgreSQL server already uses port 5432, either use that server and
skip Compose, or stop it before starting this container. When using your own
server, adjust `config/dev.exs` and `config/test.exs` to match its credentials.
The configured role must be able to create databases.

## Checks

```sh
MIX_ENV=test mix deps.get --check-locked
MIX_ENV=test mix compile --warnings-as-errors
mix format --check-formatted
mix test
```

`mix test` creates and migrates `synixir_test` before running the generated JSON
error tests. PostgreSQL is required. Test partitions append `MIX_TEST_PARTITION`
to the test database name.

The [CI workflow](.github/workflows/ci.yml) runs these checks on pull requests
and pushes to `main`. It uses the versions in `.tool-versions` and the same
PostgreSQL image as Compose. Each run gets a fresh database. CI checks formatting
without modifying files and fails if dependency resolution would change
`mix.lock`. GitHub runs the workflow once the file is pushed as part of a pull
request or to `main`.

Production runtime configuration is in `config/runtime.exs`. It reads
`DATABASE_URL` and `SECRET_KEY_BASE`, with optional `PHX_HOST`, `PORT`, and
`POOL_SIZE` settings. Production provisioning and deployment are not configured.

Generated with the [Phoenix 1.8.13 generator](https://phoenix.hexdocs.pm/1.8.13/Mix.Tasks.Phx.New.html),
using PostgreSQL and disabling HTML, assets, LiveDashboard, Gettext, and mailer
generation.

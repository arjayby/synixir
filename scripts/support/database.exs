Code.require_file("operations.exs", __DIR__)

defmodule Synixir.Script.Database do
  @moduledoc "PostgreSQL backups and isolated restore/load drills."
  alias Synixir.Script, as: S
  @isolated ~r/\Asynixir_(load|drill|restore)_[a-f0-9]{12}\z/

  def command(container, tool, args) do
    prefix = if container, do: ["docker", "exec", "-i", container], else: []

    user =
      if container && "--version" not in args,
        do: ["--username", System.get_env("PGUSER", "postgres")],
        else: []

    prefix ++ [tool] ++ user ++ args
  end

  def sql(container, database, query) do
    command(container, "psql", [
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--dbname",
      database,
      "--tuples-only",
      "--no-align",
      "--command",
      query
    ])
    |> S.run()
    |> String.trim()
  end

  def isolated!(name) do
    if not Regex.match?(@isolated, name),
      do: raise(ArgumentError, "Expected an isolated operations database")

    name
  end

  def fresh(container, kind, fun) do
    name = isolated!("synixir_#{kind}_#{S.token()}")
    sql(container, "postgres", ~s(CREATE DATABASE "#{name}" TEMPLATE template0;))

    try do
      fun.(name)
    after
      sql(container, "postgres", ~s(DROP DATABASE "#{name}" WITH \(FORCE\);))
    end
  end

  def digest(path) do
    path
    |> File.stream!([], 64 * 1024)
    |> Enum.reduce(:crypto.hash_init(:sha256), &:crypto.hash_update(&2, &1))
    |> :crypto.hash_final()
    |> Base.encode16(case: :lower)
  end

  def backup(container, database, archive) do
    if not Regex.match?(~r/\A[A-Za-z_][A-Za-z0-9_]{0,62}\z/, database),
      do: raise(ArgumentError, "Pass a plain database name, not a connection string")

    S.unused!(archive)
    S.unused!(archive <> ".json")
    started = S.now()

    migrations =
      sql(container, database, "SELECT version FROM schema_migrations ORDER BY version")
      |> String.split("\n", trim: true)

    version = command(container, "pg_dump", ["--version"]) |> S.run() |> String.trim()
    S.private_file(archive, "")

    try do
      command(container, "pg_dump", ["--format=custom", "--dbname", database])
      |> S.run(stdout: archive)
    rescue
      error ->
        File.rm!(archive)
        reraise error, __STACKTRACE__
    end

    metadata = %{
      "started_at" => started,
      "finished_at" => S.now(),
      "database" => database,
      "tool" => version,
      "migrations_before_dump" => migrations,
      "bytes" => File.stat!(archive).size,
      "sha256" => digest(archive)
    }

    S.private_json(archive <> ".json", metadata)
    metadata
  end

  def restore(container, archive, target, role \\ nil) do
    isolated!(target)

    if digest(archive) != S.json(archive <> ".json")["sha256"],
      do: raise("Archive checksum mismatch")

    args = [
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      target
    ]

    command(container, "pg_restore", args ++ if(role, do: ["--role", role], else: []))
    |> S.run(stdin: archive)
  end

  def app_env(database) do
    isolated!(database)

    [{"MIX_ENV", "test"}, {"SYNIXIR_OPERATIONS_DATABASE", database}] ++
      Enum.map(~w(PHX_SERVER SYNIXIR_BROWSER_TEST DATABASE_URL MIX_TEST_PARTITION), &{&1, nil})
  end

  def mix(database, args) do
    output = S.run(["mix" | args], env: app_env(database))
    if String.contains?(output, "OPERATIONS_RESULT="), do: S.result(output, "OPERATIONS_RESULT=")
  end

  def check(database, args), do: mix(database, ["run", "scripts/operations/restore.exs" | args])

  def verify(container, archive, fixture \\ nil) do
    started = S.monotonic()

    result =
      fresh(container, "restore", fn target ->
        restore(container, archive, target)
        check(target, if(fixture, do: ["drill-verify", fixture], else: ["verify"]))
      end)

    Map.put(result, "restore_and_check_seconds", Float.round((S.monotonic() - started) / 1000, 3))
  end

  def drill(container) do
    S.temporary(fn directory ->
      fresh(container, "drill", fn source ->
        mix(source, ["ecto.migrate", "--quiet"])
        mix(source, ["run", "scripts/operations/limits.exs"])
        fixture = Path.join(directory, "expectations.json")
        S.private_json(fixture, %{})
        check(source, ["seed", fixture])
        archive = Path.join(directory, "backup.dump")
        backup = backup(container, source, archive)

        Map.merge(verify(container, archive, fixture), %{
          "archive_bytes" => backup["bytes"],
          "recorded_at" => backup["finished_at"],
          "backup_tool" => backup["tool"],
          "isolated_limits_checks" => true
        })
      end)
    end)
  end

  def load(container, clients, rooms, writes, port, output) do
    unless clients in 1..100 and rooms in 1..clients and writes in 1..1000,
      do: raise(ArgumentError, "Use 1-100 clients, 1-clients rooms, and 1-1000 writes per client")

    unless port in 1024..65535 and port not in [4000, 4010, 5173, 5174],
      do:
        raise(
          ArgumentError,
          "Choose an unused unprivileged port separate from development/browser fixtures"
        )

    {:ok, probe} = :gen_tcp.listen(port, ip: {127, 0, 0, 1})
    :ok = :gen_tcp.close(probe)

    fresh(container, "load", fn database ->
      mix(database, ["ecto.migrate", "--quiet"])

      env =
        Map.new(app_env(database))
        |> Map.merge(%{
          "PHX_SERVER" => "true",
          "PORT" => to_string(port),
          "SYNIXIR_METRICS_TOKEN" => S.token(32)
        })

      child = S.start(["mix", "phx.server"], env: env)

      {metrics, report} =
        try do
          S.eventually(
            fn ->
              if not S.running?(child), do: raise("Isolated load server exited")
              S.http_status("http://127.0.0.1:#{port}/health/ready", timeout: 1000) == 200
            end,
            "Isolated load server did not start"
          )

          S.run(
            [
              "node",
              "--import",
              "tsx",
              "scripts/operations/load.ts"
              | Enum.map([port, clients, rooms, writes], &to_string/1)
            ],
            env: env
          )
          |> JSON.decode!()
          |> Map.pop!("metrics_text")
        rescue
          error ->
            S.log_tail(child.stdout)
            S.log_tail(child.stderr)
            reraise error, __STACKTRACE__
        after
          S.stop(child)
        end

      report = Map.put(report, "stored_documents", check(database, ["verify"]))
      S.private_file(output <> ".prom", metrics)
      S.private_json(output, report)
      report
    end)
  end
end

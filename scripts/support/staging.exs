Code.require_file("database.exs", __DIR__)

defmodule Synixir.Script.Stage do
  @moduledoc "Manage an isolated, loopback-only Docker staging installation."
  alias Synixir.Script, as: S
  alias Synixir.Script.Database
  @project ~r/\Asynixir-(staging|pilot-[a-f0-9]{12})\z/

  def initialize(directory, project, port, image) do
    unless Regex.match?(@project, project),
      do: raise(ArgumentError, "Use synixir-staging or synixir-pilot-<12 lowercase hex digits>")

    unless port in 1024..65535 and port not in [4000, 4010, 4012, 5173, 5174, 5432],
      do: raise(ArgumentError, "Choose a separate unprivileged HTTPS port")

    unless Regex.match?(~r/\A[A-Za-z0-9][A-Za-z0-9._\/:@-]+\z/, image),
      do: raise(ArgumentError, "Use a Docker image tag or digest")

    existing =
      S.run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=#{project}"])

    volumes =
      S.run([
        "docker",
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=#{project}"
      ])

    unless String.trim(existing) == "" and String.trim(volumes) == "",
      do:
        raise(
          "That Compose project already owns resources; retain its existing staging configuration"
        )

    File.mkdir_p!(Path.dirname(directory))
    S.private_directory(directory)

    values = %{
      "SYNIXIR_STAGE_PROJECT" => project,
      "SYNIXIR_STAGE_PORT" => to_string(port),
      "SYNIXIR_STAGE_UID" => S.run(["id", "-u"]) |> String.trim(),
      "SYNIXIR_STAGE_GID" => S.run(["id", "-g"]) |> String.trim(),
      "SYNIXIR_STAGE_DIR" => directory,
      "SYNIXIR_IMAGE" => image,
      "POSTGRES_PASSWORD" => S.token(32),
      "SYNIXIR_DATABASE_PASSWORD" => S.token(32),
      "SECRET_KEY_BASE" => S.token(64),
      "RELEASE_COOKIE" => S.token(32),
      "SYNIXIR_METRICS_TOKEN" => S.token(32)
    }

    S.private_file(Path.join(directory, ".env"), dotenv(values))

    S.run([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "30",
      "-keyout",
      Path.join(directory, "localhost.key"),
      "-out",
      Path.join(directory, "localhost.crt"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1"
    ])

    File.chmod!(Path.join(directory, "localhost.key"), 0o600)

    S.private_file(Path.join(directory, "prometheus.yml"), """
    global:
      scrape_interval: 5s
      evaluation_interval: 5s
    rule_files:
      - /etc/prometheus/alerts.yml
    scrape_configs:
      - job_name: synixir
        scrape_timeout: 3s
        authorization:
          credentials: #{JSON.encode!(values["SYNIXIR_METRICS_TOKEN"])}
        static_configs:
          - targets: ["app:4000"]
    """)

    IO.puts("Initialized #{project} in #{directory}. Credentials and TLS key are private files.")
  end

  defp dotenv(settings),
    do: Enum.map(settings, fn {key, value} -> [key, "=", JSON.encode!(value), "\n"] end)

  def open(directory) do
    settings =
      Path.join(directory, ".env")
      |> File.read!()
      |> String.split("\n", trim: true)
      |> Map.new(fn line ->
        [key, value] = String.split(line, "=", parts: 2)
        {key, JSON.decode!(value)}
      end)

    unless Path.expand(settings["SYNIXIR_STAGE_DIR"]) == directory,
      do: raise("Staging configuration belongs to a different directory")

    unless Regex.match?(@project, settings["SYNIXIR_STAGE_PROJECT"]),
      do: raise("Invalid staging project")

    %{
      directory: directory,
      settings: settings,
      url: "https://localhost:" <> settings["SYNIXIR_STAGE_PORT"]
    }
  end

  def compose(stage, args, options \\ []) do
    env = Map.merge(stage.settings, Keyword.get(options, :overrides, %{}))

    S.run(
      [
        "docker",
        "compose",
        "--env-file",
        Path.join(stage.directory, ".env"),
        "-p",
        stage.settings["SYNIXIR_STAGE_PROJECT"],
        "-f",
        "deploy/compose.yaml" | args
      ],
      options |> Keyword.delete(:overrides) |> Keyword.put(:env, env)
    )
  end

  def build(stage) do
    revision = S.run(["git", "rev-parse", "HEAD"]) |> String.trim()

    revision =
      if String.trim(S.run(["git", "status", "--porcelain"])) == "",
        do: revision,
        else: revision <> "-dirty"

    S.run(
      [
        "docker",
        "build",
        "--build-arg",
        "REVISION=#{revision}",
        "-t",
        stage.settings["SYNIXIR_IMAGE"],
        "."
      ],
      timeout: 1_800_000,
      capture: false
    )
  end

  def up(stage) do
    compose(stage, ["up", "-d", "--wait", "--wait-timeout", "120"], capture: false)
    ready(stage)
  end

  def ready(stage) do
    S.eventually(
      fn -> health(stage, "ready") == 200 end,
      "HTTPS staging readiness did not succeed"
    )
  end

  defp health(stage, probe),
    do:
      S.http_status(stage.url <> "/health/" <> probe,
        cacert: Path.join(stage.directory, "localhost.crt")
      )

  def database(stage) do
    container = compose(stage, ["ps", "-q", "db"]) |> String.trim()
    if container == "", do: raise("Staging database is not running")
    container
  end

  def native_check(stage) do
    result =
      compose(stage, [
        "run",
        "--rm",
        "--no-deps",
        "app",
        "/app/bin/synixir",
        "eval",
        "Synixir.Release.native_check()"
      ])
      |> S.result("NATIVE_RESULT=")

    S.print(result)
    result
  end

  def outage_check(stage) do
    try do
      compose(stage, ["stop", "db"])
      unless health(stage, "live") == 200, do: raise("Liveness must survive database outage")
      unless health(stage, "ready") == 503, do: raise("Readiness must report database outage")
    after
      compose(stage, ["start", "db"])
      ready(stage)
    end
  end

  def backup(stage) do
    directory = Path.join(stage.directory, "backups")
    unless File.dir?(directory), do: S.private_directory(directory)

    archive =
      Path.join(
        directory,
        Calendar.strftime(DateTime.utc_now(), "%Y%m%dT%H%M%S") <> "-" <> S.token(3) <> ".dump"
      )

    metadata = Database.backup(database(stage), "synixir", archive)
    IO.puts("Backup saved to #{archive} (#{metadata["bytes"]} bytes)")
    archive
  end

  def verify(stage, archive) do
    db = database(stage)

    result =
      Database.fresh(db, "restore", fn target ->
        Database.sql(db, "postgres", ~s(ALTER DATABASE "#{target}" OWNER TO synixir;))
        Database.restore(db, archive, target, "synixir")
        url = "ecto://synixir:#{stage.settings["SYNIXIR_DATABASE_PASSWORD"]}@db/#{target}"

        compose(
          stage,
          [
            "run",
            "--rm",
            "--no-deps",
            "-e",
            "DATABASE_URL",
            "app",
            "/app/bin/synixir",
            "eval",
            "Synixir.Release.verify_restore()"
          ],
          overrides: %{"DATABASE_URL" => url}
        )
        |> S.result("RESTORE_RESULT=")
      end)

    S.print(result)
    result
  end

  def upgrade(stage, image) do
    target_id =
      S.run(["docker", "image", "inspect", image, "--format", "{{.Id}} "]) |> String.trim()

    container = compose(stage, ["ps", "-q", "app"]) |> String.trim()

    previous_id =
      S.run(["docker", "inspect", container, "--format", "{{.Image}} "]) |> String.trim()

    archive = backup(stage)
    verify(stage, archive)

    S.private_json(archive <> ".upgrade.json", %{
      previous_image: previous_id,
      target_image: target_id,
      target_reference: image,
      backup: archive
    })

    # One document owner per room: stop the old app before starting its replacement.
    compose(stage, ["stop", "gateway", "app"])
    override = [overrides: %{"SYNIXIR_IMAGE" => image}]

    try do
      compose(stage, ["run", "--rm", "--no-deps", "migrate"], override)

      compose(
        stage,
        ["up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "120", "app"],
        override
      )

      compose(
        stage,
        ["up", "-d", "--no-deps", "--force-recreate", "gateway", "prometheus"],
        override
      )

      ready(stage)
    rescue
      _ ->
        compose(stage, ["stop", "gateway", "app"])

        raise "Upgrade failed; app and gateway are stopped. Preserve the backup and inspect migration logs before rollback."
    end

    settings = Map.put(stage.settings, "SYNIXIR_IMAGE", image)
    temporary = Path.join(stage.directory, ".env-" <> S.token())
    S.private_file(temporary, dotenv(settings))
    File.rename!(temporary, Path.join(stage.directory, ".env"))
    %{stage | settings: settings}
  end

  def check_pilot(stage),
    do:
      S.run(
        [
          "node",
          "scripts/staging-pilot.js",
          "verify",
          stage.url,
          Path.join(stage.directory, "pilot.json")
        ],
        capture: false
      )

  def pilot(stage) do
    manifest = Path.join(stage.directory, "pilot.json")

    if File.exists?(manifest),
      do: raise("Pilot already ran in this installation; use check-pilot to verify it")

    native = native_check(stage)
    S.private_json(manifest, %{})

    try do
      S.run(["node", "scripts/staging-pilot.js", "seed", stage.url, manifest], capture: false)
    rescue
      error ->
        if S.json(manifest) == %{}, do: File.rm!(manifest)
        reraise error, __STACKTRACE__
    end

    outage_check(stage)
    stage = upgrade(stage, stage.settings["SYNIXIR_IMAGE"])
    check_pilot(stage)
    restored = verify(stage, backup(stage))

    S.eventually(
      fn ->
        targets =
          compose(stage, [
            "exec",
            "-T",
            "prometheus",
            "wget",
            "-qO-",
            "http://localhost:9090/api/v1/targets"
          ])
          |> JSON.decode!()
          |> get_in(["data", "activeTargets"])

        targets != [] and Enum.all?(targets, &(&1["health"] == "up"))
      end,
      "Prometheus did not scrape the private metrics endpoint"
    )

    report = %{
      checked_at: S.now(),
      image: stage.settings["SYNIXIR_IMAGE"],
      https: true,
      secure_cookies: true,
      collaboration_and_roles: true,
      offline_reconnect: true,
      same_image_upgrade: true,
      private_metrics_scraped: true,
      restored_database: restored,
      native_libraries: native,
      database_outage_recovery: true,
      image_id:
        S.run([
          "docker",
          "image",
          "inspect",
          stage.settings["SYNIXIR_IMAGE"],
          "--format",
          "{{.Id}}"
        ])
        |> String.trim()
    }

    S.private_json(Path.join(stage.directory, "pilot-result.json"), report)
    S.print(report)
  end

  def rehearse(image, port, output) do
    S.unused!(output)
    local = Path.join(S.root(), ".local")
    File.mkdir_p!(local)

    S.temporary(
      fn temporary ->
        directory = Path.join(temporary, "stage")
        initialize(directory, "synixir-pilot-" <> S.token(), port, image)
        stage = open(directory)

        try do
          up(stage)
          pilot(stage)
          S.private_json(output, S.json(Path.join(directory, "pilot-result.json")))
        after
          # Remove only the project and fixture volume created by this invocation.
          compose(stage, ["down", "--volumes"], capture: false)
        end
      end,
      local
    )
  end
end

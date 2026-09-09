#!/usr/bin/env python3
"""Manage an isolated, loopback-only Docker staging installation of the production release."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import tempfile
import time
from urllib.request import urlopen
from urllib.error import HTTPError
from operations.database import Database, private_json

ROOT = Path(__file__).resolve().parents[1]


def command(args, *, capture=False, env=None, timeout=300):
    result = subprocess.run(args, cwd=ROOT, env=env, timeout=timeout,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        if capture:
            # Release logs contain no generated credentials. Never print command arguments or environment.
            print(result.stdout.decode(errors="replace")[-4000:])
            print(result.stderr.decode(errors="replace")[-4000:])
        raise RuntimeError(f"{args[0]} exited with {result.returncode}")
    return result.stdout.decode() if capture else None


def write_private(path, text):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
        out.write(text)


def initialize(directory, project, port, image):
    if not re.fullmatch(r"synixir-(staging|pilot-[a-f0-9]{12})", project):
        raise ValueError("Use synixir-staging or synixir-pilot-<12 lowercase hex digits>")
    if not 1024 <= port <= 65535 or port in [4000, 4010, 4012, 5173, 5174, 5432]:
        raise ValueError("Choose a separate unprivileged HTTPS port")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]+", image):
        raise ValueError("Use a Docker image tag or digest")
    # Refuse an existing project or directory; initialization never rotates a live DB password.
    existing = command(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"], capture=True)
    volumes = command(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}"], capture=True)
    if existing.strip() or volumes.strip():
        raise ValueError("That Compose project already owns resources; retain its existing staging configuration")
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    values = {"SYNIXIR_STAGE_PROJECT": project, "SYNIXIR_STAGE_PORT": str(port),
              "SYNIXIR_STAGE_UID": str(os.getuid()), "SYNIXIR_STAGE_GID": str(os.getgid()),
              "SYNIXIR_STAGE_DIR": str(directory), "SYNIXIR_IMAGE": image,
              "POSTGRES_PASSWORD": secrets.token_hex(32), "SYNIXIR_DATABASE_PASSWORD": secrets.token_hex(32),
              "SECRET_KEY_BASE": secrets.token_hex(64), "RELEASE_COOKIE": secrets.token_hex(32),
              "SYNIXIR_METRICS_TOKEN": secrets.token_hex(32)}
    # JSON quoting is valid for Compose dotenv values, including paths containing spaces.
    write_private(directory / ".env", "".join(f"{key}={json.dumps(value)}\n" for key, value in values.items()))
    command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "30",
             "-keyout", str(directory / "localhost.key"), "-out", str(directory / "localhost.crt"),
             "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], capture=True)
    (directory / "localhost.key").chmod(0o600)
    write_private(directory / "prometheus.yml", """global:
  scrape_interval: 5s
  evaluation_interval: 5s
rule_files:
  - /etc/prometheus/alerts.yml
scrape_configs:
  - job_name: synixir
    scrape_timeout: 3s
    authorization:
      credentials: """ + json.dumps(values["SYNIXIR_METRICS_TOKEN"]) + """
    static_configs:
      - targets: ["app:4000"]
""")
    print(f"Initialized {project} in {directory}. Credentials and TLS key are private files.")


class Stage:
    def __init__(self, directory):
        self.directory = directory
        self.settings = dict(line.split("=", 1) for line in (directory / ".env").read_text().splitlines() if line)
        self.settings = {key: json.loads(value) for key, value in self.settings.items()}
        if Path(self.settings["SYNIXIR_STAGE_DIR"]) != directory:
            raise ValueError("Staging configuration belongs to a different directory")
        if not re.fullmatch(r"synixir-(staging|pilot-[a-f0-9]{12})", self.settings["SYNIXIR_STAGE_PROJECT"]):
            raise ValueError("Invalid staging project")
        self.url = "https://localhost:" + self.settings["SYNIXIR_STAGE_PORT"]

    def compose(self, *args, capture=False, overrides=None, timeout=300):
        # Explicit values prevent an unrelated shell variable from selecting another project or volume.
        env = dict(os.environ, **self.settings)
        env.update(overrides or {})
        return command(["docker", "compose", "--env-file", str(self.directory / ".env"),
                        "-p", self.settings["SYNIXIR_STAGE_PROJECT"], "-f", "deploy/compose.yaml", *args],
                       capture=capture, env=env, timeout=timeout)

    def build(self):
        revision = command(["git", "rev-parse", "HEAD"], capture=True).strip()
        if command(["git", "status", "--porcelain"], capture=True).strip():
            revision += "-dirty"
        command(["docker", "build", "--build-arg", f"REVISION={revision}",
                 "-t", self.settings["SYNIXIR_IMAGE"], "."], timeout=1800)

    def up(self):
        self.compose("up", "-d", "--wait", "--wait-timeout", "120")
        self.ready()

    def ready(self):
        context = ssl.create_default_context(cafile=str(self.directory / "localhost.crt"))
        deadline = time.monotonic() + 30
        while True:
            try:
                with urlopen(self.url + "/health/ready", context=context, timeout=3) as response:
                    if response.status == 200:
                        return
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("HTTPS staging readiness did not succeed")
                time.sleep(0.2)

    def database(self):
        container = self.compose("ps", "-q", "db", capture=True).strip()
        if not container:
            raise RuntimeError("Staging database is not running")
        return Database(container)

    def native_check(self):
        output = self.compose("run", "--rm", "--no-deps", "app", "/app/bin/synixir", "eval",
                              "Synixir.Release.native_check()", capture=True)
        line = next(line for line in output.splitlines() if line.startswith("NATIVE_RESULT="))
        result = json.loads(line.split("=", 1)[1])
        print(json.dumps(result, indent=2))
        return result

    def outage_check(self):
        context = ssl.create_default_context(cafile=str(self.directory / "localhost.crt"))
        try:
            self.compose("stop", "db")
            with urlopen(self.url + "/health/live", context=context, timeout=5) as response:
                assert response.status == 200, "liveness must survive database outage"
            try:
                urlopen(self.url + "/health/ready", context=context, timeout=5)
            except HTTPError as error:
                assert error.code == 503, "readiness must report database outage"
            else:
                raise RuntimeError("Readiness accepted an unavailable database")
        finally:
            self.compose("start", "db")
            self.ready()

    def backup(self):
        directory = self.directory / "backups"
        directory.mkdir(mode=0o700, exist_ok=True)
        archive = directory / (time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(3) + ".dump")
        metadata = self.database().backup("synixir", archive)
        print(f"Backup saved to {archive} ({metadata['bytes']} bytes)")
        return archive

    def verify(self, archive):
        db = self.database()
        with db.fresh("restore") as target:
            db.sql("postgres", f'ALTER DATABASE "{target}" OWNER TO synixir;')
            db.restore(archive, target, role="synixir")
            url = f"ecto://synixir:{self.settings['SYNIXIR_DATABASE_PASSWORD']}@db/{target}"
            output = self.compose("run", "--rm", "--no-deps", "-e", "DATABASE_URL", "app",
                                  "/app/bin/synixir", "eval", "Synixir.Release.verify_restore()",
                                  capture=True, overrides={"DATABASE_URL": url})
            line = next(line for line in output.splitlines() if line.startswith("RESTORE_RESULT="))
            result = json.loads(line.split("=", 1)[1])
        print(json.dumps(result, indent=2))
        return result

    def upgrade(self, image):
        target_id = command(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True).strip()
        container = self.compose("ps", "-q", "app", capture=True).strip()
        previous_id = command(["docker", "inspect", container, "--format", "{{.Image}}"], capture=True).strip()
        archive = self.backup()
        self.verify(archive)
        private_json(Path(str(archive) + ".upgrade.json"), {"previous_image": previous_id,
                     "target_image": target_id, "target_reference": image, "backup": str(archive)})
        # One document owner per room: stop the old app before starting the replacement.
        self.compose("stop", "gateway", "app")
        override = {"SYNIXIR_IMAGE": image}
        try:
            self.compose("run", "--rm", "--no-deps", "migrate", overrides=override)
            self.compose("up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "120", "app", overrides=override)
            self.compose("up", "-d", "--no-deps", "--force-recreate", "gateway", "prometheus", overrides=override)
            self.ready()
        except BaseException:
            self.compose("stop", "gateway", "app")
            raise RuntimeError("Upgrade failed; app and gateway are stopped. Preserve the backup and inspect migration logs before rollback.") from None
        self.settings["SYNIXIR_IMAGE"] = image
        temporary = self.directory / (".env-" + secrets.token_hex(6))
        write_private(temporary, "".join(f"{key}={json.dumps(value)}\n" for key, value in self.settings.items()))
        temporary.replace(self.directory / ".env")

    def pilot(self):
        manifest = self.directory / "pilot.json"
        if manifest.exists():
            raise ValueError("Pilot already ran in this installation; use check-pilot to verify it")
        native = self.native_check()
        private_json(manifest, {})
        try:
            command(["node", "scripts/staging-pilot.js", "seed", self.url, str(manifest)])
        except BaseException:
            if json.loads(manifest.read_text()) == {}:
                manifest.unlink()
            raise
        self.outage_check()
        self.upgrade(self.settings["SYNIXIR_IMAGE"])
        command(["node", "scripts/staging-pilot.js", "verify", self.url, str(manifest)])
        restored = self.verify(self.backup())
        deadline = time.monotonic() + 30
        while True:
            output = self.compose("exec", "-T", "prometheus", "wget", "-qO-",
                                  "http://localhost:9090/api/v1/targets", capture=True)
            targets = json.loads(output)["data"]["activeTargets"]
            if targets and all(target["health"] == "up" for target in targets):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Prometheus did not scrape the private metrics endpoint")
            time.sleep(1)
        report = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "image": self.settings["SYNIXIR_IMAGE"], "https": True, "secure_cookies": True,
                  "collaboration_and_roles": True, "offline_reconnect": True, "same_image_upgrade": True,
                  "private_metrics_scraped": True, "restored_database": restored,
                  "native_libraries": native, "database_outage_recovery": True}
        report["image_id"] = command(["docker", "image", "inspect", self.settings["SYNIXIR_IMAGE"],
                                      "--format", "{{.Id}}"], capture=True).strip()
        private_json(self.directory / "pilot-result.json", report)
        print(json.dumps(report, indent=2))


def rehearse(image, port, output):
    if output.exists():
        raise ValueError("Rehearsal output exists; choose a new path")
    local = ROOT / ".local"
    local.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="release-pilot-", dir=local) as temporary:
        directory = Path(temporary) / "stage"
        project = "synixir-pilot-" + secrets.token_hex(6)
        initialize(directory, project, port, image)
        stage = Stage(directory)
        try:
            stage.up()
            stage.pilot()
            private_json(output, json.loads((directory / "pilot-result.json").read_text()))
        finally:
            # Only remove the new project and fixture volume owned by this invocation.
            stage.compose("down", "--volumes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / ".local/staging")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--project", default="synixir-staging")
    init.add_argument("--port", type=int, default=8443)
    init.add_argument("--image", default="synixir:staging")
    for name in ["build", "up", "status", "stop", "backup", "pilot", "check-pilot", "native-check", "outage-check"]:
        commands.add_parser(name)
    verify = commands.add_parser("verify")
    verify.add_argument("archive", type=Path)
    upgrade = commands.add_parser("upgrade")
    upgrade.add_argument("--image", required=True)
    rehearsal = commands.add_parser("rehearse")
    rehearsal.add_argument("--image", required=True)
    rehearsal.add_argument("--port", type=int, default=8444)
    rehearsal.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.command == "rehearse":
        rehearse(args.image, args.port, args.output.resolve())
        return
    if args.command == "init":
        initialize(directory, args.project, args.port, args.image)
        return
    stage = Stage(directory)
    if args.command == "verify":
        stage.verify(args.archive.resolve())
    elif args.command == "upgrade":
        stage.upgrade(args.image)
    elif args.command == "status":
        stage.compose("ps")
    elif args.command == "stop":
        stage.compose("stop")
    elif args.command == "check-pilot":
        command(["node", "scripts/staging-pilot.js", "verify", stage.url, str(directory / "pilot.json")])
    else:
        getattr(stage, args.command.replace("-", "_"))()
    if args.command in ["up", "status", "pilot"]:
        print(f"Staging: {stage.url}")


if __name__ == "__main__":
    main()

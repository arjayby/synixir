#!/usr/bin/env python3
"""Full PostgreSQL backups and isolated restore/load drills. Python standard library only."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ISOLATED = re.compile(r"synixir_(load|drill|restore)_[a-f0-9]{12}\Z")


def run(args, **kwargs):
    result = subprocess.run(args, cwd=ROOT, check=False, timeout=300, **kwargs)
    if result.returncode:
        for stream in [result.stdout, result.stderr]:
            if isinstance(stream, bytes):
                print(stream.decode(errors="replace")[-6000:], file=sys.stderr)
        raise RuntimeError(f"{args[0]} failed (exit {result.returncode})")
    return result


def private_json(path, value):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
        json.dump(value, out, indent=2)
        out.write("\n")


class Database:
    def __init__(self, container):
        self.container = container

    def command(self, tool, *args):
        # Container tools connect to their own PostgreSQL via its local socket.
        # Native tools follow libpq's PG* environment, including PGPASSFILE.
        prefix = ["docker", "exec", "-i", self.container] if self.container else []
        user = ["--username", os.environ.get("PGUSER", "postgres")] if self.container and "--version" not in args else []
        return prefix + [tool] + user + list(args)

    def sql(self, database, sql):
        return run(self.command("psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
                                "--dbname", database, "--tuples-only", "--no-align"),
                   input=sql.encode(), stdout=subprocess.PIPE).stdout.decode().strip()

    @contextlib.contextmanager
    def fresh(self, kind):
        name = f"synixir_{kind}_{secrets.token_hex(6)}"
        assert ISOLATED.fullmatch(name)
        # Only a successfully created name enters cleanup. Never adopt an existing DB.
        self.sql("postgres", f'CREATE DATABASE "{name}" TEMPLATE template0;')
        try:
            yield name
        finally:
            self.sql("postgres", f'DROP DATABASE "{name}" WITH (FORCE);')

    def backup(self, database, archive):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", database):
            raise ValueError("Pass a plain database name, not a connection string")
        if archive.exists() or Path(str(archive) + ".json").exists():
            raise ValueError("Backup output already exists")
        started = datetime.now(timezone.utc).isoformat()
        migrations = self.sql(database, "SELECT version FROM schema_migrations ORDER BY version").splitlines()
        version = run(self.command("pg_dump", "--version"), stdout=subprocess.PIPE).stdout.decode().strip()
        with open(os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as out:
            try:
                run(self.command("pg_dump", "--format=custom", "--dbname", database), stdout=out)
            except BaseException:
                archive.unlink(missing_ok=True)
                raise
        with archive.open("rb") as data:
            digest = hashlib.file_digest(data, "sha256").hexdigest()
        metadata = {"started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(),
                    "database": database, "tool": version, "migrations_before_dump": migrations,
                    "bytes": archive.stat().st_size,
                    "sha256": digest}
        private_json(str(archive) + ".json", metadata)
        return metadata

    def restore(self, archive, target, role=None):
        assert ISOLATED.fullmatch(target)
        metadata = json.loads(Path(str(archive) + ".json").read_text())
        with archive.open("rb") as data:
            if hashlib.file_digest(data, "sha256").hexdigest() != metadata["sha256"]:
                raise ValueError("Archive checksum mismatch")
            data.seek(0)
            role_args = ["--role", role] if role else []
            run(self.command("pg_restore", "--single-transaction", "--exit-on-error",
                             "--no-owner", "--no-privileges", "--dbname", target, *role_args), stdin=data)


def app_env(database):
    assert ISOLATED.fullmatch(database)
    env = dict(os.environ, MIX_ENV="test", SYNIXIR_OPERATIONS_DATABASE=database)
    for key in ["PHX_SERVER", "SYNIXIR_BROWSER_TEST", "DATABASE_URL", "MIX_TEST_PARTITION"]:
        env.pop(key, None)
    return env


def mix(database, *args):
    result = run(["mix", *args], env=app_env(database), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = result.stdout.decode()
    for line in output.splitlines():
        if line.startswith("OPERATIONS_RESULT="):
            return json.loads(line.removeprefix("OPERATIONS_RESULT="))
    return None


def check(database, *args):
    return mix(database, "run", "scripts/operations/restore.exs", *args)


def verify(db, archive, fixture=None):
    started = time.monotonic()
    with db.fresh("restore") as target:
        db.restore(archive, target)
        result = check(target, "drill-verify", str(fixture)) if fixture else check(target, "verify")
    return dict(result, restore_and_check_seconds=round(time.monotonic() - started, 3))


def drill(db):
    with tempfile.TemporaryDirectory(prefix="synixir-drill-") as directory, db.fresh("drill") as source:
        mix(source, "ecto.migrate", "--quiet")
        mix(source, "run", "scripts/operations/limits.exs")
        fixture = Path(directory) / "expectations.json"
        private_json(fixture, {})
        check(source, "seed", str(fixture))
        archive = Path(directory) / "backup.dump"
        backup = db.backup(source, archive)
        return dict(verify(db, archive, fixture), archive_bytes=backup["bytes"],
                    recorded_at=backup["finished_at"], backup_tool=backup["tool"],
                    isolated_limits_checks=True)


def load(db, clients, rooms, writes, port, output):
    if not (1 <= clients <= 100 and 1 <= rooms <= clients and 1 <= writes <= 1000):
        raise ValueError("Use 1–100 clients, 1–clients rooms, and 1–1000 writes per client")
    if not 1024 <= port <= 65535 or port in [4000, 4010, 5173, 5174]:
        raise ValueError("Choose an unused unprivileged port separate from development/browser fixtures")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    with db.fresh("load") as database, tempfile.TemporaryFile() as logs:
        mix(database, "ecto.migrate", "--quiet")
        env = dict(app_env(database), PHX_SERVER="true", PORT=str(port),
                   SYNIXIR_METRICS_TOKEN=secrets.token_hex(32))
        child = subprocess.Popen(["mix", "phx.server"], cwd=ROOT, env=env,
                                 stdout=logs, stderr=logs, start_new_session=True)
        try:
            deadline = time.monotonic() + 30
            while True:
                if child.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Isolated load server did not start")
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health/ready", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            result = run(["node", "scripts/operations/load.js", str(port), str(clients),
                          str(rooms), str(writes)], env=env, stdout=subprocess.PIPE)
            report = json.loads(result.stdout)
            metrics = report.pop("metrics_text")
        except BaseException:
            logs.seek(0, os.SEEK_END)
            logs.seek(max(0, logs.tell() - 6000))
            print(logs.read().decode(errors="replace"), file=sys.stderr)
            raise
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        report["stored_documents"] = check(database, "verify")
        with open(os.open(str(output) + ".prom", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as scrape:
            scrape.write(metrics)
        private_json(output, report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-container", help="Use this PostgreSQL container's local tools")
    sub = parser.add_subparsers(dest="command", required=True)
    backup = sub.add_parser("backup")
    backup.add_argument("--database", required=True)
    backup.add_argument("--output", type=Path, required=True)
    restore = sub.add_parser("verify")
    restore.add_argument("archive", type=Path)
    for name in ["drill", "load"]:
        command = sub.add_parser(name)
        command.add_argument("--output", type=Path, required=True)
        if name == "load":
            command.add_argument("--clients", type=int, default=12)
            command.add_argument("--rooms", type=int, default=3)
            command.add_argument("--writes", type=int, default=20)
            command.add_argument("--port", type=int, default=4012)
    args = parser.parse_args()
    db = Database(args.docker_container)
    if getattr(args, "output", None) and args.output.exists():
        parser.error("Output exists; choose a new path")
    if args.command == "load" and Path(str(args.output) + ".prom").exists():
        parser.error("Metrics output exists; choose a new path")
    if args.command == "backup":
        result = db.backup(args.database, args.output)
    elif args.command == "verify":
        result = verify(db, args.archive)
    elif args.command == "drill":
        result = drill(db)
        private_json(args.output, result)
    else:
        result = load(db, args.clients, args.rooms, args.writes, args.port, args.output)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

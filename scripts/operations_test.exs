Code.require_file("support/staging.exs", __DIR__)
ExUnit.start()

defmodule Synixir.ScriptTest do
  use ExUnit.Case, async: false
  alias Synixir.Script, as: S
  alias Synixir.Script.{Database, Stage}

  test "structured command results can follow ordinary application logs" do
    assert S.result("starting app\nOPERATIONS_RESULT={\"ok\":true}\n", "OPERATIONS_RESULT=") ==
             %{"ok" => true}

    assert_raise RuntimeError, "Command did not return OPERATIONS_RESULT=", fn ->
      S.result("starting app\n", "OPERATIONS_RESULT=")
    end
  end

  test "HTTPS trusts the saved self-signed certificate and rejects other certificates and hosts" do
    S.temporary(fn directory ->
      for name <- ["trusted", "other"] do
        S.run([
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-keyout",
          Path.join(directory, name <> ".key"),
          "-out",
          Path.join(directory, name <> ".crt"),
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost"
        ])
      end

      {:ok, probe} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
      {:ok, port} = :inet.port(probe)
      :gen_tcp.close(probe)
      trusted = Path.join(directory, "trusted.crt")

      child =
        S.start([
          "openssl",
          "s_server",
          "-accept",
          "127.0.0.1:#{port}",
          "-www",
          "-cert",
          trusted,
          "-key",
          Path.join(directory, "trusted.key")
        ])

      try do
        S.eventually(
          fn -> S.http_status("https://localhost:#{port}", cacert: trusted) == 200 end,
          "TLS fixture did not start",
          5000
        )

        assert is_nil(
                 S.http_status("https://localhost:#{port}",
                   cacert: Path.join(directory, "other.crt")
                 )
               )

        assert is_nil(S.http_status("https://127.0.0.1:#{port}", cacert: trusted))
      after
        S.stop(child)
      end
    end)
  end

  test "commands preserve literal arguments, binary streams, and environment overrides" do
    S.temporary(fn directory ->
      input = Path.join(directory, "input with spaces")
      output = Path.join(directory, "output with spaces")
      bytes = <<0, 255, 10, 13, 0, 128>>
      S.private_file(input, bytes)
      S.private_file(output, "")
      S.run(["cat"], stdin: input, stdout: output)
      assert File.read!(output) == bytes

      assert S.run(["printf", "%s", "$(echo wrong) `echo wrong` ' \" $HOME"]) ==
               "$(echo wrong) `echo wrong` ' \" $HOME"

      assert S.run(["sh", "-c", "printf '%s' \"$SYNIXIR_SCRIPT_TEST\""],
               env: [{"SYNIXIR_SCRIPT_TEST", "literal value"}]
             ) == "literal value"

      assert S.run(["sh", "-c", "printf '%s' \"${HOME-unset}\""], env: [{"HOME", nil}]) == "unset"
    end)
  end

  test "command failures propagate and timeouts stop children" do
    assert_raise RuntimeError, "sh exited with 7", fn -> S.run(["sh", "-c", "exit 7"]) end

    S.temporary(fn directory ->
      marker = Path.join(directory, "child survived")

      assert_raise RuntimeError, "sh timed out", fn ->
        S.run(["sh", "-c", "(sleep 1; touch \"$1\") & wait", "test", marker], timeout: 100)
      end

      Process.sleep(1100)
      refute File.exists?(marker)
    end)
  end

  test "private files reject replacement and private temporary directories clean up on error" do
    directory =
      S.temporary(fn directory ->
        path = Path.join(directory, "secret.json")
        S.private_json(path, %{secret: "value"})
        assert Bitwise.band(File.stat!(path).mode, 0o777) == 0o600
        assert Bitwise.band(File.stat!(directory).mode, 0o777) == 0o700
        assert_raise MatchError, fn -> S.private_file(path, "replacement") end
        assert S.json(path) == %{"secret" => "value"}
        directory
      end)

    refute File.exists?(directory)

    assert_raise RuntimeError, "fixture failed", fn ->
      S.temporary(fn path ->
        send(self(), {:temporary, path})
        raise "fixture failed"
      end)
    end

    assert_received {:temporary, path}
    refute File.exists?(path)
  end

  test "existing staging JSON dotenv values remain readable" do
    S.temporary(fn directory ->
      settings = %{
        "SYNIXIR_STAGE_DIR" => directory,
        "SYNIXIR_STAGE_PROJECT" => "synixir-staging",
        "SYNIXIR_STAGE_PORT" => "8443",
        "SYNIXIR_IMAGE" => "synixir:staging",
        "EXTRA" => "a=b \"quoted\""
      }

      S.private_file(
        Path.join(directory, ".env"),
        Enum.map(settings, fn {key, value} ->
          [key, "=", JSON.encode!(value), "\n"]
        end)
      )

      assert Stage.open(directory).settings == settings
      assert Stage.open(directory).url == "https://localhost:8443"
    end)
  end

  test "restore rejects ordinary databases and corrupt archives before running PostgreSQL" do
    assert_raise ArgumentError, fn -> Database.restore(nil, "/missing.dump", "synixir_dev") end

    S.temporary(fn directory ->
      archive = Path.join(directory, "backup.dump")
      S.private_file(archive, "original")
      S.private_json(archive <> ".json", %{sha256: Database.digest(archive)})
      File.write!(archive, "corrupted")

      assert_raise RuntimeError, "Archive checksum mismatch", fn ->
        Database.restore(nil, archive, "synixir_restore_012345abcdef")
      end
    end)
  end
end

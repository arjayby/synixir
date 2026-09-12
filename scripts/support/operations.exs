defmodule Synixir.Script do
  @moduledoc "Shared, dependency-free support for the operations CLIs."
  @root Path.expand("../..", __DIR__)

  def root, do: @root
  def token(bytes \\ 6), do: Base.encode16(:crypto.strong_rand_bytes(bytes), case: :lower)
  def now, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  def monotonic, do: System.monotonic_time(:millisecond)
  def json(path), do: path |> File.read!() |> JSON.decode!()
  def print(value), do: IO.puts(JSON.encode!(value))

  def private_file(path, content) do
    {:ok, file} = :file.open(String.to_charlist(path), [:write, :binary, :exclusive])

    try do
      File.chmod!(path, 0o600)
      :ok = :file.write(file, content)
    after
      :file.close(file)
    end
  end

  def private_json(path, value), do: private_file(path, [JSON.encode!(value), "\n"])

  def private_directory(path) do
    File.mkdir!(path)
    File.chmod!(path, 0o700)
    path
  end

  def temporary(fun, parent \\ System.tmp_dir!()) do
    directory = private_directory(Path.join(parent, "synixir-" <> token()))

    try do
      fun.(directory)
    after
      File.rm_rf!(directory)
    end
  end

  # Redirect binary archives through files, never through a shell-interpolated command
  # or an in-memory string. Every command argument is passed as a separate argv value.
  def start([program | args], options \\ []) do
    executable = System.find_executable(program) || raise "Required command not found: #{program}"
    directory = private_directory(Path.join(System.tmp_dir!(), "synixir-command-" <> token()))
    stdout = Keyword.get(options, :stdout, Path.join(directory, "stdout"))
    stderr = Path.join(directory, "stderr")
    stdin = Keyword.get(options, :stdin, "/dev/null")
    if not Keyword.has_key?(options, :stdout), do: private_file(stdout, "")
    private_file(stderr, "")

    env =
      Enum.map(Keyword.get(options, :env, []), fn {key, value} ->
        {String.to_charlist(key), if(value, do: String.to_charlist(value), else: false)}
      end)

    try do
      port =
        Port.open({:spawn_executable, System.find_executable("sh")}, [
          :binary,
          :exit_status,
          :hide,
          args: [
            "-c",
            "input=$1; output=$2; errors=$3; shift 3; exec \"$@\" <\"$input\" >\"$output\" 2>\"$errors\"",
            "synixir-command",
            stdin,
            stdout,
            stderr,
            executable | args
          ],
          cd: @root,
          env: env
        ])

      {:os_pid, pid} = Port.info(port, :os_pid)

      %{
        port: port,
        pid: pid,
        directory: directory,
        stdout: stdout,
        stderr: stderr,
        program: program
      }
    rescue
      error ->
        File.rm_rf!(directory)
        reraise error, __STACKTRACE__
    end
  end

  def run(args, options \\ []) do
    child = start(args, options)

    try do
      receive do
        {port, {:exit_status, status}} when port == child.port ->
          unless status == 0 do
            log_tail(child.stderr)
            unless Keyword.has_key?(options, :stdout), do: log_tail(child.stdout)
            raise "#{child.program} exited with #{status}"
          end

          unless Keyword.has_key?(options, :stdout) do
            output = File.read!(child.stdout)
            if Keyword.get(options, :capture, true), do: output, else: IO.write(output)
          end
      after
        Keyword.get(options, :timeout, 300_000) ->
          raise "#{child.program} timed out"
      end
    after
      stop(child)
    end
  end

  def running?(child), do: Port.info(child.port) != nil

  def stop(child) do
    if running?(child) do
      # Mix can launch a BEAM child. Stop descendants as well before removing fixtures.
      {processes, 0} = System.cmd("ps", ["-axo", "pid=,ppid="])
      pairs = Enum.map(String.split(processes, "\n", trim: true), &String.split/1)
      pids = descendants(pairs, Integer.to_string(child.pid)) ++ [Integer.to_string(child.pid)]
      System.cmd("kill", ["-TERM" | pids], stderr_to_stdout: true)
      deadline = monotonic() + 10_000
      await_exit(child, deadline)
      # Descendants may outlive the port's immediate child.
      alive =
        Enum.filter(pids, fn pid ->
          elem(System.cmd("kill", ["-0", pid], stderr_to_stdout: true), 1) == 0
        end)

      if alive != [], do: System.cmd("kill", ["-KILL" | alive], stderr_to_stdout: true)
      if running?(child), do: Port.close(child.port)
    end

    File.rm_rf!(child.directory)
    :ok
  end

  defp descendants(pairs, parent) do
    for [pid, ppid] <- pairs, ppid == parent, child <- descendants(pairs, pid) ++ [pid], do: child
  end

  defp await_exit(child, deadline) do
    if running?(child) and monotonic() < deadline do
      Process.sleep(50)
      await_exit(child, deadline)
    end
  end

  def log_tail(path) do
    {:ok, file} = :file.open(String.to_charlist(path), [:read, :binary])

    try do
      {:ok, size} = :file.position(file, :eof)
      {:ok, _} = :file.position(file, max(0, size - 6000))

      case :file.read(file, 6000) do
        {:ok, content} -> IO.binwrite(:stderr, content)
        :eof -> :ok
      end
    after
      :file.close(file)
    end
  end

  def http_status(url, options \\ []) do
    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    ssl =
      case options[:cacert] do
        nil ->
          []

        path ->
          certificates =
            for {:Certificate, der, :not_encrypted} <- :public_key.pem_decode(File.read!(path)),
                do: der

          [
            verify: :verify_peer,
            cacertfile: String.to_charlist(path),
            verify_fun: {&verify_certificate/3, {certificates, URI.parse(url).host}},
            log_level: :error,
            customize_hostname_check: [
              match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
            ]
          ]
      end

    case :httpc.request(
           :get,
           {String.to_charlist(url), []},
           [
             timeout: options[:timeout] || 3000,
             connect_timeout: options[:timeout] || 3000,
             autoredirect: false,
             ssl: ssl
           ],
           []
         ) do
      {:ok, {{_, status, _}, _, _}} -> status
      {:error, _} -> nil
    end
  end

  # OTP reports a self-signed leaf separately even when it is in cacertfile.
  # Trust only the saved certificate, and still validate its dates and hostname.
  defp verify_certificate(certificate, {:bad_cert, :selfsigned_peer}, {trusted, host} = state) do
    der = :public_key.pkix_encode(:OTPCertificate, certificate, :otp)

    valid =
      der in trusted and
        match?({:ok, _}, :public_key.pkix_path_validation(certificate, [der], [])) and
        :public_key.pkix_verify_hostname(certificate, [{:dns_id, String.to_charlist(host)}],
          match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
        )

    if valid, do: {:valid, state}, else: {:fail, :untrusted_staging_certificate}
  end

  defp verify_certificate(_, {:bad_cert, reason}, _), do: {:fail, reason}
  defp verify_certificate(_, {:extension, _}, state), do: {:unknown, state}

  defp verify_certificate(_, event, state) when event in [:valid, :valid_peer],
    do: {:valid, state}

  def eventually(fun, message, timeout \\ 30_000) do
    poll(fun, message, monotonic() + timeout)
  end

  defp poll(fun, message, deadline) do
    unless fun.() do
      if monotonic() >= deadline, do: raise(message)
      Process.sleep(200)
      poll(fun, message, deadline)
    end
  end

  def result(output, prefix) do
    line = Enum.find(String.split(output, "\n"), &String.starts_with?(&1, prefix))
    if is_nil(line), do: raise("Command did not return #{prefix}")
    line |> String.replace_prefix(prefix, "") |> JSON.decode!()
  end

  def parse(argv, switches, commands, usage) do
    {options, args, invalid} = OptionParser.parse(argv, strict: [help: :boolean] ++ switches)

    if options[:help] do
      IO.puts(usage)
      :help
    else
      if invalid != [] or args == [] or hd(args) not in commands, do: raise(ArgumentError, usage)
      {options, args}
    end
  end

  def required(options, key), do: options[key] || raise(ArgumentError, "Missing --#{key}")

  def unused!(path) do
    if File.exists?(path), do: raise(ArgumentError, "Output exists; choose a new path: #{path}")
    path
  end

  def cli(fun) do
    try do
      fun.()
    rescue
      error ->
        IO.puts(:stderr, Exception.message(error))
        System.halt(1)
    end
  end
end

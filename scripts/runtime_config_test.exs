ExUnit.start()

defmodule Synixir.RuntimeConfigTest do
  use ExUnit.Case, async: false

  @runtime Path.expand("../config/runtime.exs", __DIR__)
  @url "postgresql://user:password@db.example.com/synixir"

  setup do
    values = %{
      "DATABASE_URL" => @url,
      "SECRET_KEY_BASE" => String.duplicate("test", 32),
      "SYNIXIR_PUBLIC_URL" => "https://example.onrender.com",
      "RENDER" => nil,
      "SYNIXIR_OPERATIONS_DATABASE" => nil
    }

    original = Map.new(values, fn {key, _value} -> {key, System.get_env(key)} end)
    System.put_env(values)
    on_exit(fn -> System.put_env(original) end)
    :ok
  end

  test "Render enables TLS even when the database URL has no SSL query parameter" do
    System.put_env("RENDER", "true")
    assert repo_config()[:ssl] == true
  end

  test "libpq modes requiring TLS enable Postgrex SSL outside Render too" do
    for mode <- ["require", "verify-ca", "verify-full"] do
      url = @url <> "?sslmode=#{mode}&connect_timeout=15"
      System.put_env("DATABASE_URL", url)
      config = repo_config()
      assert config[:ssl] == true
      assert config[:url] == url
    end
  end

  test "local staging does not require TLS without a request in the URL" do
    assert repo_config()[:ssl] == false
    System.put_env("RENDER", "false")
    assert repo_config()[:ssl] == false
  end

  test "Ecto SSL query parameters and escaped credentials are preserved" do
    for ssl <- ["true", "false"] do
      url = "postgresql://user:p%40ss%26word@db.example.com/synixir?ssl=#{ssl}"
      System.put_env("DATABASE_URL", url)
      assert repo_config()[:url] == url
    end
  end

  defp repo_config do
    @runtime
    |> Config.Reader.read!(env: :prod, target: :host)
    |> Keyword.fetch!(:synixir)
    |> Keyword.fetch!(Synixir.Repo)
  end
end

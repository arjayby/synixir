#!/usr/bin/env elixir
Code.require_file("../support/database.exs", __DIR__)

defmodule Synixir.Script.DatabaseCLI do
  alias Synixir.Script, as: S
  alias Synixir.Script.Database

  @usage """
  Usage: elixir scripts/operations/database.exs [--docker-container NAME] COMMAND
    backup --database NAME --output PATH
    verify ARCHIVE
    drill --output PATH
    load --output PATH [--clients 12] [--rooms 3] [--writes 20] [--port 4012]
  """

  def main(argv) do
    case S.parse(
           argv,
           [
             docker_container: :string,
             database: :string,
             output: :string,
             clients: :integer,
             rooms: :integer,
             writes: :integer,
             port: :integer
           ],
           ~w(backup verify drill load),
           @usage
         ) do
      :help -> :ok
      {options, args} -> execute(options, args)
    end
  end

  defp execute(options, args) do
    container = options[:docker_container]
    output = if options[:output], do: options[:output] |> Path.expand() |> S.unused!()

    result =
      case args do
        ["backup"] ->
          Database.backup(
            container,
            S.required(options, :database),
            output || S.required(options, :output)
          )

        ["verify", archive] ->
          Database.verify(container, Path.expand(archive))

        ["drill"] ->
          S.required(options, :output)
          result = Database.drill(container)
          S.private_json(output, result)
          result

        ["load"] ->
          S.required(options, :output)
          S.unused!(output <> ".prom")

          Database.load(
            container,
            options[:clients] || 12,
            options[:rooms] || 3,
            options[:writes] || 20,
            options[:port] || 4012,
            output
          )

        _ ->
          raise ArgumentError, @usage
      end

    S.print(result)
  end
end

Synixir.Script.cli(fn -> Synixir.Script.DatabaseCLI.main(System.argv()) end)

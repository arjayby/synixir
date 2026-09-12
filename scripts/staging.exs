#!/usr/bin/env elixir
Code.require_file("support/staging.exs", __DIR__)

defmodule Synixir.Script.StagingCLI do
  alias Synixir.Script, as: S
  alias Synixir.Script.Stage

  @commands ~w(init build up status stop backup pilot check-pilot native-check outage-check verify upgrade rehearse)
  @usage """
  Usage: elixir scripts/staging.exs [--directory PATH] COMMAND
    init [--project synixir-staging] [--port 8443] [--image synixir:staging]
    build | up | status | stop | backup | pilot | check-pilot | native-check | outage-check
    verify ARCHIVE
    upgrade --image IMAGE
    rehearse --image IMAGE --output PATH [--port 8444]
  """

  def main(argv) do
    case S.parse(
           argv,
           [
             directory: :string,
             project: :string,
             port: :integer,
             image: :string,
             output: :string
           ],
           @commands,
           @usage
         ) do
      :help -> :ok
      {options, args} -> execute(options, args)
    end
  end

  defp execute(options, args) do
    directory = Path.expand(options[:directory] || Path.join(S.root(), ".local/staging"))

    case args do
      ["init"] ->
        Stage.initialize(
          directory,
          options[:project] || "synixir-staging",
          options[:port] || 8443,
          options[:image] || "synixir:staging"
        )

      ["rehearse"] ->
        Stage.rehearse(
          S.required(options, :image),
          options[:port] || 8444,
          Path.expand(S.required(options, :output))
        )

      _ ->
        dispatch(Stage.open(directory), args, options)
    end
  end

  defp dispatch(stage, args, options) do
    case args do
      ["build"] -> Stage.build(stage)
      ["up"] -> Stage.up(stage)
      ["status"] -> Stage.compose(stage, ["ps"], capture: false)
      ["stop"] -> Stage.compose(stage, ["stop"], capture: false)
      ["backup"] -> Stage.backup(stage)
      ["pilot"] -> Stage.pilot(stage)
      ["check-pilot"] -> Stage.check_pilot(stage)
      ["native-check"] -> Stage.native_check(stage)
      ["outage-check"] -> Stage.outage_check(stage)
      ["verify", archive] -> Stage.verify(stage, Path.expand(archive))
      ["upgrade"] -> Stage.upgrade(stage, S.required(options, :image))
      _ -> raise ArgumentError, @usage
    end

    if hd(args) in ~w(up status pilot), do: IO.puts("Staging: #{stage.url}")
  end
end

Synixir.Script.cli(fn -> Synixir.Script.StagingCLI.main(System.argv()) end)

defmodule Synixir.Release do
  @moduledoc "Maintenance and smoke checks for releases, without Mix or an HTTP listener."

  def native_check do
    {:ok, _} = Application.ensure_all_started(:crypto)
    doc = Yex.Doc.new()
    text = Yex.Doc.get_text(doc, "check")
    :ok = Yex.Text.insert(text, 0, "native 🌍")
    {:ok, update} = Yex.encode_state_as_update(doc)
    {:ok, merged} = Yex.merge_updates([update, update])
    restored = Yex.Doc.new()
    :ok = Yex.apply_update(restored, merged)
    "native 🌍" = restored |> Yex.Doc.get_text("check") |> Yex.Text.to_string()
    hash = Argon2.hash_pwd_salt("native release check", t_cost: 1, m_cost: 8)
    true = Argon2.verify_pass("native release check", hash)

    result = %{
      yex: true,
      argon2: true,
      architecture: to_string(:erlang.system_info(:system_architecture)),
      otp: System.otp_release()
    }

    IO.puts("NATIVE_RESULT=" <> Jason.encode!(result))
    result
  end

  def migrate do
    with_repo(fn repo -> Ecto.Migrator.run(repo, :up, all: true) end)
  end

  def verify_restore do
    result = with_repo(fn _ -> Synixir.Operations.Restore.verify() end)
    IO.puts("RESTORE_RESULT=" <> Jason.encode!(result))
    result
  end

  defp with_repo(fun) do
    {:ok, _} = Application.ensure_all_started(:ssl)
    :ok = Application.ensure_loaded(:synixir)
    {:ok, result, _} = Ecto.Migrator.with_repo(Synixir.Repo, fun)
    result
  end
end

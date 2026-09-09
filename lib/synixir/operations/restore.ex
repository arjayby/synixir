defmodule Synixir.Operations.Restore do
  @moduledoc "Read-only verification of a restored database against this release's schema and Yjs data."
  import Ecto.Query
  alias Synixir.{Accounts.User, Documents.Store, Repo}

  def verify do
    applied = Repo.all(from m in "schema_migrations", order_by: m.version, select: m.version)

    expected =
      Application.app_dir(:synixir, "priv/repo/migrations/*.exs")
      |> Path.wildcard()
      |> Enum.map(&(Path.basename(&1) |> String.split("_") |> hd() |> String.to_integer()))
      |> Enum.sort()

    if applied != expected, do: raise("archive schema does not match this release")
    %{rows: [[0]]} = Repo.query!("SELECT count(*) FROM pg_index WHERE NOT indisvalid")

    for table <- ["document_updates", "document_snapshots"] do
      {:ok, _} =
        Repo.transaction(fn ->
          Repo.stream(from row in table, select: {row.data, row.digest})
          |> Enum.each(fn {data, digest} ->
            if :crypto.hash(:sha256, data) != digest, do: raise("stored checksum mismatch")
            :ok = Yex.apply_update(Yex.Doc.new(), data)
          end)
        end)
    end

    %{rows: rooms} =
      Repo.query!("""
      SELECT id FROM rooms UNION SELECT room_id FROM document_updates
      UNION SELECT room_id FROM document_snapshots
      """)

    Enum.each(rooms, fn [room] -> Store.restore(room, Yex.Doc.new()) end)

    %{
      rooms_verified: length(rooms),
      migrations: applied,
      users: Repo.aggregate(User, :count),
      updates: Repo.aggregate("document_updates", :count),
      snapshots: Repo.aggregate("document_snapshots", :count)
    }
  end
end

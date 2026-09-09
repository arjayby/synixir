defmodule Synixir.Documents.Store do
  @moduledoc false

  import Ecto.Query
  alias Synixir.Repo

  def restore(room_id, doc) do
    updates =
      Repo.all(
        from update in "document_updates",
          where: update.room_id == ^room_id,
          order_by: update.id,
          select: update.data
      )

    Yex.Doc.transaction(doc, :restore, fn ->
      Enum.each(updates, fn update -> :ok = Yex.apply_update(doc, update) end)
    end)

    :ok
  end

  def append(room_id, update) do
    Repo.insert_all(
      "document_updates",
      [
        %{
          room_id: room_id,
          data: update,
          digest: :crypto.hash(:sha256, update),
          inserted_at: DateTime.utc_now()
        }
      ],
      on_conflict: :nothing,
      conflict_target: [:room_id, :digest]
    )

    :ok
  end
end

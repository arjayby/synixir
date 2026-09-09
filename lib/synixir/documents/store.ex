defmodule Synixir.Documents.Store do
  @moduledoc false

  import Ecto.Query
  alias Synixir.Repo

  def restore(room_id, doc) do
    started = System.monotonic_time()

    try do
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

      record(:restore, started, :ok, %{
        updates: length(updates),
        bytes: Enum.reduce(updates, 0, &(byte_size(&1) + &2))
      })

      :ok
    rescue
      error ->
        record(:restore, started, :storage_unavailable, %{updates: 0, bytes: 0})
        reraise error, __STACKTRACE__
    end
  end

  def append(room_id, update) do
    started = System.monotonic_time()

    try do
      {inserted, _} =
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

      record(:save, started, :ok, %{bytes: byte_size(update), inserted: inserted})
      :ok
    rescue
      error ->
        record(:save, started, :storage_unavailable, %{bytes: byte_size(update), inserted: 0})
        reraise error, __STACKTRACE__
    end
  end

  defp record(operation, started, result, measurements) do
    :telemetry.execute(
      [:synixir, :document, operation],
      Map.merge(measurements, %{duration: System.monotonic_time() - started, count: 1}),
      %{result: result}
    )
  end
end

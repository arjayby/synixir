defmodule Synixir.Documents.Store do
  @moduledoc false

  import Ecto.Query
  alias Synixir.Repo

  def restore(room_id, doc) do
    measure(:restore, %{updates: 0, bytes: 0}, fn ->
      locked(room_id, fn ->
        snapshot = snapshot(room_id)

        updates =
          Repo.all(
            from u in "document_updates",
              where: u.room_id == ^room_id,
              order_by: u.id,
              select: u.data
          )

        data = if snapshot, do: [checked_snapshot!(snapshot) | updates], else: updates

        Yex.Doc.transaction(doc, :restore, fn ->
          Enum.each(data, fn update -> :ok = Yex.apply_update(doc, update) end)
        end)

        stats = %{updates: length(updates), bytes: bytes(updates)}
        {stats, %{updates: length(data), bytes: bytes(data)}}
      end)
    end)
  end

  def append(room_id, update), do: append_applied(room_id, update, fn -> :ok end)

  def append_applied(room_id, update, apply_update) do
    persist(room_id, update, apply_update, &Repo.transaction/1)
  end

  # Authorization, capacity check, live apply, and raw insert share a transaction.
  # A quota rejection must happen before mutating the live document.
  def append_authorized(room_id, update, grant, apply_update) do
    persist(room_id, update, apply_update, fn fun ->
      Synixir.RoomAccess.with_access(grant, :write, fn _ -> fun.() end)
    end)
  end

  defp persist(room_id, update, apply_update, authorize) do
    started = System.monotonic_time()

    try do
      result =
        authorize.(fn ->
          locked(room_id, fn ->
            with :ok <- capacity(room_id, update) do
              :ok = apply_update.()
              {:ok, insert_update(room_id, update)}
            end
          end)
        end)

      case result do
        {:ok, {:ok, inserted}} ->
          record(:save, started, :ok, %{bytes: byte_size(update), inserted: inserted})
          :ok

        {:ok, {:error, reason}} ->
          record(:save, started, reason, %{bytes: byte_size(update), inserted: 0})
          {:error, reason}

        {:error, reason} ->
          record(:save, started, reason, %{bytes: byte_size(update), inserted: 0})
          {:error, reason}
      end
    rescue
      error ->
        record(:save, started, :storage_unavailable, %{bytes: byte_size(update), inserted: 0})
        reraise error, __STACKTRACE__
    end
  end

  defp capacity(room_id, update) do
    digest = :crypto.hash(:sha256, update)

    # Duplicate delivery consumes no additional log space, including a retry
    # after a lost acknowledgement at the quota boundary.
    if Repo.exists?(
         from u in "document_updates", where: u.room_id == ^room_id and u.digest == ^digest
       ) do
      :ok
    else
      %{rows: [[stored]]} =
        Repo.query!(
          """
          SELECT COALESCE((SELECT sum(octet_length(data)) FROM document_updates WHERE room_id = $1), 0)
               + COALESCE((SELECT octet_length(data) FROM document_snapshots WHERE room_id = $1), 0)
          """,
          [room_id]
        )

      if stored + byte_size(update) <=
           Application.fetch_env!(:synixir, :quotas)[:stored_bytes_per_room] do
        :ok
      else
        :telemetry.execute([:synixir, :quota, :rejected], %{count: 1}, %{reason: :storage_quota})
        {:error, :storage_quota}
      end
    end
  end

  defp insert_update(room_id, update) do
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

    inserted
  end

  # Merge bytes, never a materialized Yex document: encode_state_as_update/1 in
  # Yex 0.10.5 omits pending structs and pending delete sets. A merged update is
  # a complete replay snapshot, including data awaiting missing dependencies.
  def compact(room_id) do
    measure(:compact, %{updates: 0, bytes: 0}, fn ->
      locked(room_id, fn ->
        previous = snapshot(room_id)

        rows =
          Repo.all(
            from u in "document_updates",
              where: u.room_id == ^room_id,
              order_by: u.id,
              select: %{id: u.id, data: u.data}
          )

        case rows do
          [] ->
            {:ok, %{updates: 0, bytes: 0}}

          _ ->
            updates = Enum.map(rows, & &1.data)
            inputs = if previous, do: [checked_snapshot!(previous) | updates], else: updates
            {:ok, data} = Yex.merge_updates(inputs)
            through_id = List.last(rows).id

            Repo.insert_all(
              "document_snapshots",
              [
                %{
                  room_id: room_id,
                  through_id: through_id,
                  data: data,
                  digest: :crypto.hash(:sha256, data),
                  inserted_at: DateTime.utc_now()
                }
              ],
              on_conflict: {:replace, [:through_id, :data, :digest, :inserted_at]},
              conflict_target: [:room_id]
            )

            Repo.delete_all(
              from u in "document_updates",
                where: u.room_id == ^room_id and u.id <= ^through_id
            )

            {:ok, %{updates: length(rows), bytes: byte_size(data)}}
        end
      end)
    end)
  end

  defp snapshot(room_id) do
    Repo.one(
      from s in "document_snapshots",
        where: s.room_id == ^room_id,
        select: %{data: s.data, digest: s.digest}
    )
  end

  defp checked_snapshot!(%{data: data, digest: digest}) do
    if :crypto.hash(:sha256, data) != digest, do: raise("snapshot checksum mismatch")
    data
  end

  # All store operations share a per-room transaction lock. This also prevents
  # restore from seeing a new snapshot with an old log (or the reverse), and
  # serializes maintenance callers with append. Hash collisions only serialize
  # unrelated rooms; they cannot mix their data.
  defp locked(room_id, fun) do
    {:ok, result} =
      Repo.transaction(fn ->
        Repo.query!("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [room_id])
        fun.()
      end)

    result
  end

  defp bytes(updates), do: Enum.reduce(updates, 0, &(byte_size(&1) + &2))

  defp measure(operation, failure, fun) do
    started = System.monotonic_time()

    try do
      {result, measurements} = fun.()
      record(operation, started, :ok, measurements)
      result
    rescue
      error ->
        record(operation, started, :storage_unavailable, failure)
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

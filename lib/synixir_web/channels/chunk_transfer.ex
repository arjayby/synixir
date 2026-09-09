defmodule SynixirWeb.ChunkTransfer do
  @moduledoc false

  # v1 header: event kind (u8), transfer id, byte offset, total bytes (u32 BE).
  @events %{0 => "yjs", 1 => "yjs_sync", 2 => "save_update"}
  @header_bytes 13

  def limits do
    config = Application.fetch_env!(:synixir, :collaboration_limits)

    %{
      max_message_bytes: config[:max_message_bytes],
      chunk_bytes: min(config[:chunk_bytes], config[:max_message_bytes] - @header_bytes),
      max_transfer_bytes: config[:max_transfer_bytes],
      transfer_timeout_ms: config[:transfer_timeout_ms]
    }
  end

  def accept(partial, message, limits) do
    case decode(message, limits) do
      {:ok, kind, id, offset, total, data} ->
        partial =
          if offset == 0 do
            discard(partial)
            token = make_ref()

            timer =
              Process.send_after(self(), {:transfer_expired, token}, limits.transfer_timeout_ms)

            %{
              kind: kind,
              id: id,
              total: total,
              offset: 0,
              parts: [],
              token: token,
              timer: timer,
              deadline: System.monotonic_time(:millisecond) + limits.transfer_timeout_ms
            }
          else
            partial
          end

        case partial do
          %{kind: ^kind, id: ^id, total: ^total, offset: ^offset} ->
            next = %{partial | offset: offset + byte_size(data), parts: [data | partial.parts]}

            cond do
              System.monotonic_time(:millisecond) >= next.deadline ->
                discard(next)
                {:error, :invalid_chunk}

              next.offset == total ->
                discard(next)

                {:complete, Map.fetch!(@events, kind),
                 next.parts |> Enum.reverse() |> IO.iodata_to_binary()}

              true ->
                {:more, next}
            end

          _ ->
            discard(partial)
            {:error, :invalid_chunk}
        end

      {:error, reason} ->
        discard(partial)
        {:error, reason}
    end
  end

  defp decode(<<kind, id::32, offset::32, total::32, data::binary>>, limits)
       when kind in 0..2 and total > 0 and byte_size(data) > 0 do
    cond do
      byte_size(data) > limits.chunk_bytes or total > limits.max_transfer_bytes ->
        {:error, :message_too_large}

      offset + byte_size(data) > total ->
        {:error, :invalid_chunk}

      true ->
        {:ok, kind, id, offset, total, data}
    end
  end

  defp decode(_, _limits), do: {:error, :invalid_chunk}

  def discard(nil), do: :ok
  def discard(partial), do: Process.cancel_timer(partial.timer)

  def chunks(message, id, size), do: chunks(message, id, size, byte_size(message), 0)
  defp chunks(<<>>, _id, _size, _total, _offset), do: []

  defp chunks(message, id, size, total, offset) do
    length = min(size, byte_size(message))
    <<part::binary-size(length), rest::binary>> = message

    [
      <<0, id::32, offset::32, total::32, part::binary>>
      | chunks(rest, id, size, total, offset + length)
    ]
  end
end

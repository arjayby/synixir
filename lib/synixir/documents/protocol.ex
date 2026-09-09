defmodule Synixir.Documents.Protocol do
  @moduledoc false

  alias Yex.{Awareness, Doc, Sync}

  # Decode and validate in the caller before entering the shared room process.
  # A disposable document keeps malformed client data away from live state.
  def decode(kind, message, mode \\ :message)

  def decode(kind, message, mode) when is_binary(message) do
    limits = Application.fetch_env!(:synixir, :collaboration_limits)

    maximum = if mode == :transfer, do: :max_transfer_bytes, else: :max_message_bytes

    if byte_size(message) <= Keyword.fetch!(limits, maximum) do
      validate(kind, message, limits)
    else
      {:error, :message_too_large}
    end
  rescue
    _error -> {:error, :invalid_message}
  end

  def decode(_kind, _message, _mode), do: {:error, :invalid_message}

  defp validate(:update, update, _limits) do
    case Yex.apply_update(Doc.new(), update) do
      :ok -> {:ok, {:update, update}}
      _ -> {:error, :invalid_message}
    end
  end

  defp validate(:sync, message, limits) do
    case Sync.message_decode(message) do
      {:ok, {:sync, {kind, update}}} when kind in [:sync_step2, :sync_update] ->
        validate(:update, update, limits)

      {:ok, {:sync, {:sync_step1, vector}}} ->
        case Sync.get_sync_step2(Doc.new(), vector) do
          {:ok, _reply} -> {:ok, {:sync_step1, vector}}
          _ -> {:error, :invalid_message}
        end

      {:ok, {:awareness, update}} ->
        validate_awareness(update, limits)

      {:ok, :query_awareness} ->
        {:ok, :query_awareness}

      _ ->
        {:error, :invalid_message}
    end
  end

  defp validate_awareness(update, limits) do
    if byte_size(update) <= Keyword.fetch!(limits, :max_awareness_bytes) do
      {:ok, awareness} = Awareness.new(Doc.new())

      with :ok <- Awareness.apply_update(awareness, update),
           true <-
             Enum.all?(Awareness.get_states(awareness), fn {_id, state} -> valid_state?(state) end) do
        {:ok, {:awareness, update}}
      else
        _ -> {:error, :invalid_message}
      end
    else
      {:error, :message_too_large}
    end
  end

  defp valid_state?(state) when is_map(state) do
    valid_user?(state["user"]) and valid_cursor?(state["cursor"])
  end

  defp valid_state?(_state), do: false
  defp valid_user?(nil), do: true

  defp valid_user?(user) when is_map(user) do
    optional?(user["name"], &short_string?/1) and
      optional?(user["color"], &color?/1) and optional?(user["colorLight"], &color?/1)
  end

  defp valid_user?(_user), do: false
  defp valid_cursor?(nil), do: true

  defp valid_cursor?(%{"anchor" => anchor, "head" => head}) do
    valid_position?(anchor) and valid_position?(head)
  end

  defp valid_cursor?(_cursor), do: false

  defp valid_position?(position) when is_map(position) do
    optional?(position["type"], &valid_id?/1) and
      optional?(position["item"], &valid_id?/1) and
      optional?(position["tname"], &short_string?/1) and
      optional?(position["assoc"], &integer_between?(&1, -1, 1))
  end

  defp valid_position?(_position), do: false
  defp valid_id?(%{"client" => client, "clock" => clock}), do: uint?(client) and uint?(clock)
  defp valid_id?(_id), do: false
  defp uint?(value), do: integer_between?(value, 0, 9_007_199_254_740_991)

  # Yex exposes JSON numbers as floats, including integer client IDs and clocks.
  defp integer_between?(value, min, max) do
    is_number(value) and value >= min and value <= max and trunc(value) == value
  end

  defp short_string?(value),
    do: is_binary(value) and byte_size(value) <= 128 and String.valid?(value)

  defp color?(value) when is_binary(value),
    do: Regex.match?(~r/\A#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\z/, value)

  defp color?(_value), do: false
  defp optional?(nil, _validator), do: true
  defp optional?(value, validator), do: validator.(value)
end

defmodule Synixir.RoomAccess do
  @moduledoc """
  Issues and verifies signed grants to join one room as a particular user.

  Only trusted server code should issue grants, after checking the user's room
  permissions. Tokens are bearer credentials valid for new joins for 15 minutes.
  Existing channel sessions remain authorized until they leave or disconnect.
  """

  @salt "synixir room access v1"
  @max_age 15 * 60

  @spec issue(String.t(), String.t()) :: {:ok, String.t()} | {:error, :invalid_claims}
  def issue(room_id, user_id) do
    if valid_claims?(room_id, user_id) do
      token =
        Phoenix.Token.sign(SynixirWeb.Endpoint, @salt, %{room_id: room_id, user_id: user_id},
          max_age: @max_age
        )

      {:ok, token}
    else
      {:error, :invalid_claims}
    end
  end

  @spec verify(String.t(), term()) :: {:ok, String.t()} | {:error, :unauthorized}
  def verify(room_id, token) when is_binary(token) do
    case Phoenix.Token.verify(SynixirWeb.Endpoint, @salt, token, max_age: @max_age) do
      {:ok, %{room_id: ^room_id, user_id: user_id}} ->
        if valid_claims?(room_id, user_id) do
          {:ok, user_id}
        else
          {:error, :unauthorized}
        end

      _ ->
        {:error, :unauthorized}
    end
  end

  def verify(_room_id, _token), do: {:error, :unauthorized}

  defp valid_claims?(room_id, user_id) do
    Synixir.Documents.valid_room_id?(room_id) and
      is_binary(user_id) and byte_size(user_id) in 1..128 and String.valid?(user_id)
  end
end

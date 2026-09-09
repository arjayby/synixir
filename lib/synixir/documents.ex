defmodule Synixir.Documents do
  @moduledoc """
  Finds or starts the single in-memory document process for a room on this node.

  Documents remain alive when clients leave. A process or server restart loses
  their state until persistence is implemented. Callers must authorize access
  before opening a room on behalf of a client.
  """

  @spec open(String.t()) :: {:ok, pid()} | {:error, term()}
  def open(room_id) do
    if valid_room_id?(room_id) do
      case Registry.lookup(Synixir.Documents.Registry, room_id) do
        [{pid, _}] -> {:ok, pid}
        [] -> start_document(room_id)
      end
    else
      {:error, :invalid_room_id}
    end
  end

  @doc """
  Room IDs are 1 to 128 ASCII letters, digits, underscores or hyphens,
  starting with a letter or digit. IDs are case-sensitive.
  """
  @spec valid_room_id?(term()) :: boolean()
  def valid_room_id?(room_id) when is_binary(room_id) and byte_size(room_id) in 1..128 do
    Regex.match?(~r/\A[A-Za-z0-9][A-Za-z0-9_-]*\z/, room_id)
  end

  def valid_room_id?(_room_id), do: false

  defp start_document(room_id) do
    child = %{
      id: room_id,
      start:
        {Yex.Sync.SharedDoc, :start_link,
         [
           [
             doc_name: room_id,
             auto_exit: false,
             doc_option: %Yex.Doc.Options{offset_kind: :utf16}
           ],
           [name: {:via, Registry, {Synixir.Documents.Registry, room_id}}]
         ]}
    }

    case DynamicSupervisor.start_child(Synixir.Documents.Workers, child) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      {:error, reason} -> {:error, reason}
    end
  end
end

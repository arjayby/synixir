defmodule SynixirWeb.DocumentSocket do
  @moduledoc """
  Each document channel join must supply its own signed room access token.
  """

  use Phoenix.Socket

  channel "document:*", SynixirWeb.DocumentChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  @impl true
  def id(_socket), do: nil
end

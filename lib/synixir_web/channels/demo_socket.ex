defmodule SynixirWeb.DemoSocket do
  @moduledoc """
  Development-only socket for the Yjs/Yex interoperability example.
  """

  use Phoenix.Socket

  channel "document:demo", SynixirWeb.DemoChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    if Application.get_env(:synixir, :collaboration_demo, false) do
      {:ok, socket}
    else
      :error
    end
  end

  @impl true
  def id(_socket), do: nil
end

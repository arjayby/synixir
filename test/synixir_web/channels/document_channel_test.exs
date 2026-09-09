defmodule SynixirWeb.DocumentChannelTest do
  use ExUnit.Case, async: true

  import Phoenix.ChannelTest

  alias Synixir.RoomAccess
  alias SynixirWeb.DocumentSocket

  @endpoint SynixirWeb.Endpoint

  test "missing, tampered, expired and invalid grants cannot join a room" do
    room_id = "denied-#{System.unique_integer([:positive])}"
    {:ok, token} = RoomAccess.issue(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})

    # A correctly signed but old grant tests expiry without waiting.
    expired =
      Phoenix.Token.sign(
        @endpoint,
        "synixir room access v1",
        %{
          room_id: room_id,
          user_id: "alice"
        },
        signed_at: System.system_time(:second) - 901
      )

    invalid_claims =
      Phoenix.Token.sign(@endpoint, "synixir room access v1", %{
        room_id: room_id,
        user_id: ""
      })

    for params <- [
          %{},
          %{"token" => nil},
          %{"token" => %{}},
          %{"token" => token <> "tampered"},
          %{"token" => expired},
          %{"token" => invalid_claims}
        ] do
      assert {:error, %{reason: "unauthorized"}} =
               subscribe_and_join(socket, "document:#{room_id}", params)
    end
  end

  test "a room token authorizes its room and supplies the signed user identity" do
    room_id = "access-#{System.unique_integer([:positive])}"
    {:ok, token} = RoomAccess.issue(room_id, "alice")
    {:ok, socket} = connect(DocumentSocket, %{})

    assert {:ok, _, joined} =
             subscribe_and_join(socket, "document:#{room_id}", %{
               "token" => token,
               "user_id" => "mallory"
             })

    assert joined.assigns.user_id == "alice"

    assert {:error, %{reason: "unauthorized"}} =
             subscribe_and_join(socket, "document:another-room", %{"token" => token})
  end
end

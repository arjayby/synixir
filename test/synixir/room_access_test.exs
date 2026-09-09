defmodule Synixir.RoomAccessTest do
  use ExUnit.Case, async: true

  alias Synixir.RoomAccess

  test "invalid room and user identities cannot receive grants" do
    for {room_id, user_id} <- [
          {"", "alice"},
          {"room/other", "alice"},
          {"room", ""},
          {"room", nil},
          {"room", String.duplicate("a", 129)},
          {"room", <<255>>}
        ] do
      assert {:error, :invalid_claims} = RoomAccess.issue(room_id, user_id)
    end
  end
end

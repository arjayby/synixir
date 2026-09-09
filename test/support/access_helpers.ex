defmodule Synixir.AccessHelpers do
  alias Synixir.{Accounts, Accounts.User, RoomAccess, Repo}
  @password "a test password with enough length"

  def account_fixture(label \\ "user") do
    username =
      label <> "_" <> (Ecto.UUID.generate() |> String.replace("-", "") |> String.slice(0, 20))

    {:ok, user} = Accounts.register(%{username: username, password: @password})
    raw = Accounts.create_session(user)
    %{user: user, raw: raw, hash: :crypto.hash(:sha256, raw), password: @password}
  end

  def issue_room_grant(room, label \\ "alice") do
    actor = account_fixture(label)
    # Trusted fixture provisioning. Production callers must use the owner API.
    now = DateTime.utc_now()
    Repo.insert_all("rooms", [%{id: room, inserted_at: now}], on_conflict: :nothing)

    Repo.insert_all("room_memberships", [
      %{
        room_id: room,
        user_id: Ecto.UUID.dump!(actor.user.id),
        role: "owner",
        version: 1,
        inserted_at: now,
        updated_at: now
      }
    ])

    {:ok, %{token: token}} = RoomAccess.issue(room, actor.hash)
    {:ok, token}
  end

  def user_by_id(id), do: Repo.get!(User, id)
end

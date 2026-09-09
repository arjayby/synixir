defmodule Synixir.Repo.Migrations.CreateAccountsAndRoomMemberships do
  use Ecto.Migration

  def change do
    create table(:users, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :username, :string, size: 32, null: false
      add :hashed_password, :text, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:users, [:username])

    create table(:user_sessions, primary_key: false) do
      add :token_hash, :binary, primary_key: true
      add :user_id, references(:users, type: :uuid, on_delete: :delete_all), null: false
      add :expires_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create index(:user_sessions, [:user_id])
    create index(:user_sessions, [:expires_at])

    create table(:rooms, primary_key: false) do
      add :id, :string, size: 128, primary_key: true
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create table(:room_memberships, primary_key: false) do
      add :room_id, references(:rooms, type: :string, on_delete: :delete_all), primary_key: true

      add :user_id, references(:users, type: :uuid, on_delete: :delete_all), primary_key: true
      add :role, :string, null: false
      add :version, :bigint, null: false, default: 1
      add :revoked_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create constraint(:room_memberships, :valid_role,
             check: "role IN ('owner', 'editor', 'viewer')"
           )

    create index(:room_memberships, [:user_id, :room_id])
  end
end

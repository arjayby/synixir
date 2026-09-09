defmodule Synixir.Repo.Migrations.CreateDocumentSnapshots do
  use Ecto.Migration

  def change do
    create table(:document_snapshots, primary_key: false) do
      add :room_id, :string, size: 128, primary_key: true
      add :through_id, :bigint, null: false
      add :data, :binary, null: false
      add :digest, :binary, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end
  end
end

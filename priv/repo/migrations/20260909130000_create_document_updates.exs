defmodule Synixir.Repo.Migrations.CreateDocumentUpdates do
  use Ecto.Migration

  def change do
    create table(:document_updates) do
      add :room_id, :string, size: 128, null: false
      add :data, :binary, null: false
      add :digest, :binary, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:document_updates, [:room_id, :digest])
    create index(:document_updates, [:room_id, :id])
  end
end

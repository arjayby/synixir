defmodule Synixir.Accounts.User do
  use Ecto.Schema
  import Ecto.Changeset
  @primary_key {:id, :binary_id, autogenerate: true}
  @derive {Jason.Encoder, only: [:id, :username]}

  schema "users" do
    field :username, :string
    field :password, :string, virtual: true, redact: true
    field :hashed_password, :string, redact: true
    timestamps(type: :utc_datetime_usec)
  end

  def registration(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:username, :password])
    |> update_change(:username, &String.downcase(String.trim(&1)))
    |> validate_required([:username, :password])
    |> validate_format(:username, ~r/\A[a-z0-9][a-z0-9_-]{2,31}\z/)
    |> validate_length(:password, min: 15, max: 128)
    |> validate_length(:password, max: 1024, count: :bytes)
    |> unique_constraint(:username)
    |> hash_password()
  end

  defp hash_password(%{valid?: true, changes: %{password: password}} = changeset) do
    changeset
    |> put_change(:hashed_password, Argon2.hash_pwd_salt(password))
    |> delete_change(:password)
  end

  defp hash_password(changeset), do: changeset
end

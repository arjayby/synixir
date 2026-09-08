defmodule Synixir.Repo do
  use Ecto.Repo,
    otp_app: :synixir,
    adapter: Ecto.Adapters.Postgres
end

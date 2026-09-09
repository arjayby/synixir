[
  import_deps: [:ecto, :ecto_sql, :phoenix],
  subdirectories: ["priv/*/migrations"],
  inputs: ["*.{ex,exs}", "{config,lib,test,scripts}/**/*.{ex,exs}", "priv/*/seeds.exs"]
]

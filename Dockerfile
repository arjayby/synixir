# Native dependencies must be built on the target architecture with the same libc as the runner.
FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS client
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/client packages/client
COPY examples/collaboration examples/collaboration
RUN npm ci && npm run build

FROM hexpm/elixir:1.18.3-erlang-27.3.3-debian-bookworm-20260610-slim@sha256:74cb9d70a6eb64b6c22c2faba3702bb8afdf09408100f692c6b47025336c6a64 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV MIX_ENV=prod
# Optional for emulated builds only; native builds and the runner keep OTP defaults.
ARG ERL_FLAGS
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
COPY config/config.exs config/prod.exs config/
RUN mix deps.get --only prod --check-locked && mix deps.compile
COPY lib lib
COPY priv priv
COPY --from=client /src/examples/collaboration/out/ priv/static/
RUN mix compile --warnings-as-errors
COPY config/runtime.exs config/
RUN mix release

FROM debian:bookworm-20260610-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses6 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ENV LANG=C.UTF-8 MIX_ENV=prod PHX_SERVER=true
WORKDIR /app
COPY --from=builder --chown=nobody:nogroup /app/_build/prod/rel/synixir/ ./
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Synixir" org.opencontainers.image.revision=$REVISION
USER nobody
EXPOSE 4000
CMD ["/app/bin/synixir", "start"]

# Next.js collaboration examples

This app uses TypeScript, React, Next.js App Router, shadcn/ui (Radix), and
Tailwind CSS. Elixir/Phoenix owns accounts, room permissions, WebSockets, and
PostgreSQL persistence. The browser consumes `@synixir/client`.

From the repository root, start Phoenix as described in the main README, then:

```sh
npm ci
npm run dev --workspace synixir-collaboration-example
```

The `predev` step compiles the SDK. Open http://127.0.0.1:5173. The development
server in `dev.ts` proxies `/api` and `/socket` to Phoenix at
http://127.0.0.1:4000; set `SYNIXIR_ENDPOINT` to override it. The proxy preserves
the browser's Origin header so Phoenix can enforce its origin allowlist.

`app/` contains the eight routes. `components/example-app.tsx` manages accounts,
room selection, and navigation. `components/workspace/workspace.tsx` owns each
SDK connection and its subscriptions, permissions, presence, and teardown.
The editor/canvas modules mount inside a React-owned host and release their
listeners and bindings when that host unmounts. They load only when selected.
`components/ui/` contains the generated shadcn primitives, and
`app/globals.css` contains Tailwind, theme tokens, and shared layout styles.

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
```

The build compiles the SDK to `packages/client/dist` and exports Next.js pages
and assets to `examples/collaboration/out`. Docker copies this export into
Phoenix's `priv/static`; the runtime needs no Node process. Existing public
URLs such as `/kanban.html?room=planning` and `/sdk.html?room=planning` are
preserved in development and production. Navigation uses full page loads to
retain the unsaved-edit warning and tear down old room connections.

Browser tests run on ports 5174 and 4010 with a separate Phoenix test database.
When testing separate Git worktrees in parallel, set `SYNIXIR_TEST_FRONTEND_PORT`
and `SYNIXIR_TEST_BACKEND_PORT` to a unique pair for each run. The test server's
origin allowlist follows the selected frontend port.
They enable a development-only inspection adapter for public SDK and editor
APIs; production builds exclude it. The package consumer check also uses Vite
to verify that the published SDK works outside Next.js.

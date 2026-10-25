# Operator console

The single-page app the gateway serves at `/console` (spec section 16): infrastructure health, deployed state, sessions
and their harness configuration, durable work, live events, and gateway logs, across every owner. It never shows
conversation content or secrets; it only renders what the operator API (`OPERATOR_ROUTES` in
`@managed-copilot/protocol/operator`) returns.

```powershell
pnpm --filter @managed-copilot/console build      # tsc + vite build → dist/ (the gateway serves it)
pnpm --filter @managed-copilot/console test       # vitest: pure logic in test/
pnpm --filter @managed-copilot/console dev        # http://localhost:7401/console/, proxying /v1 to MANAGED_COPILOT_URL
```

Sign in with `npx managed-copilot console` (add `--url <gateway>` for a remote deployment). It opens
`/console/signin#ticket=…`; the console removes the ticket from the address bar at once and redeems it exactly once
for an HttpOnly session cookie.

## How it works

- **Requests** (`src/lib/api.ts`): every operator request sends `credentials: "same-origin"` and the
  `x-managed-copilot-console: 1` header. Error bodies become `ApiError` (`code`, `message`, `status`,
  `retryAfterSeconds`). Any 401 signs the console out; a 403 shows the not-an-operator screen.
- **Polling** (`src/lib/poll.ts`): views load on mount and every 5 s while the tab is visible, share requests by key,
  and keep the last good data with an inline "Couldn't refresh" banner when a refresh fails.
- **Live stream** (`src/lib/stream.ts`, `src/lib/sse.ts`): `fetch` + `ReadableStream` with a hand-written SSE parser
  (EventSource cannot send the console header), reconnecting with backoff from 1 s to 30 s. The top bar shows Live,
  Reconnecting, or Paused, and pausing stops both the stream and auto-refresh.
- **Routing** (`src/lib/routes.ts`, `src/lib/router.ts`): History API under `/console/`; filters and tabs live in the
  query string so every view is linkable.

## Security constraints

The gateway sends a strict Content-Security-Policy (`script-src 'self'; style-src 'self'; img-src 'self' data:
https://avatars.githubusercontent.com; connect-src 'self'; form-action 'none'`). Keep `src/index.html` free of inline
scripts, styles, and `style` attributes; load images only from GitHub avatars (`safeAvatarUrl`) or `data:` URIs; never
render HTML from API data (markdown goes through react-markdown without `rehype-raw`).

## Sample data (development only)

`vite dev` with `?fixtures` (remembered for the tab; `?fixtures=off` clears it) replaces the operator API with sample
data from `src/dev/` and shows a "Sample data" badge. Variants: `?fixtures=empty`, `signed-out`, `forbidden`,
`github-down`, `flaky`, `expire` (401 mid-session), and `revoked` (403 mid-session). The fixture modules load only
behind `import.meta.env.DEV`, so production builds never contain them.

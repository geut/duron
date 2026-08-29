# AGENTS.md

## Runtime

- **Bun only.** Never use npm, pnpm, yarn, Node.js, or Vite (except `packages/docs` which uses Vite for SSR).
- Prefer Bun-native APIs: `Bun.serve`, `bun:sqlite`, `Bun.sql`, `Bun.file`, `Bun.$`, `bun:test`.
- Bun auto-loads `.env` files. Do not use `dotenv`.

## Monorepo

Bun workspaces: `docs/*` and `packages/*`.

| Package                    | Role                        | Key Entrypoints                                                                                             |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/duron`           | Core library                | `duron`, `duron/client`, `duron/action`, `duron/server`, `duron/adapters/postgres`, `duron/adapters/pglite` |
| `packages/duron-dashboard` | React dashboard             | `duron-dashboard`, `duron-dashboard/get-html`                                                               |
| `packages/docs`            | Fumadocs docs site          | Uses Vite for SSR                                                                                           |
| `packages/examples`        | Example apps                | `basic/start.ts`, `multi-worker/parent.ts`                                                                  |
| `packages/shared-actions`  | Shared actions for examples | —                                                                                                           |

## Developer Commands

```bash
# Install
bun install

# One package
cd packages/duron && bun run dev          # watch mode (tsc --watch)
cd packages/duron-dashboard && bun run dev # dashboard dev server on :3001

# Root shortcuts
bun run dev:duron          # watch core
bun run dev:dashboard      # dashboard dev server
bun run dev:examples:basic # basic example

# Verification (CI runs in this order)
bun run typecheck   # tsc --noEmit across packages
bun run lint        # oxlint check
bun run lint:fix    # oxlint fix
bun run fmt:check   # oxfmt check
bun run fmt         # oxfmt fix
bun test            # runs packages/duron tests with --concurrent

# Build
bun run build       # all packages
bun run build:docs  # docs only
```

## Database

- PostgreSQL for dev: `docker-compose up -d` → `postgres://duron:duron@localhost:5435/duron`
- PGLite for tests/development.
- Generate migrations:
  ```bash
  cd packages/duron
  bun run generate:postgres   # drizzle-kit generate
  ```

## Testing

- Framework: `bun:test`
- Tests live in `packages/duron/test/*.test.ts`
- Run single file: `bun test specific.test.ts`
- Core tests run with `--concurrent` via `bun test` in `packages/duron/package.json`
- Test setup (`test/setup.ts`) auto-creates a Docker container `duron-postgres-test` on port 5440 for PostgreSQL tests. Docker must be running.

## Lint / Format (Oxlint/Oxfmt)

- Config: `.oxlintrc.json` (oxlint), `.oxfmtrc.json` (oxfmt)
- Rules worth knowing:
  - `noConsole` → warn (use logger instead)
  - `noNonNullAssertion` → off
  - Line width: 100
  - Single quotes, no semicolons
  - Organize imports automatically

## Build Details

- `packages/duron`: `tsc --project tsconfig.node.json`
- `packages/duron-dashboard`: `NODE_ENV=production bun run build.ts && bun run build:get-html`
- Docs: `vite build`

## Dashboard

- Do **not** modify files in `src/components/ui/` (managed by Shadcn UI).
- Use existing UI components from `src/components/ui/`.
- Dashboard dev server starts on `http://localhost:3001`.

## Env Variables

| Variable         | Purpose                      |
| ---------------- | ---------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string |
| `JWT_SECRET`     | Dashboard auth               |
| `OPENAI_API_KEY` | AI examples                  |

## CI

Workflow `.github/workflows/test.yml` runs: `bun install` → `typecheck` → `lint` → `test`.

## Branch Workflow

- Create feature branches from `main` for all changes
- Do **not** use git worktrees
- Commit directly to the feature branch
- **Before every commit, run verification locally:**
  ```bash
  bun run typecheck   # TypeScript check across all packages
  bun run lint        # Lint check
  bun test            # Full test suite (not just packages/duron)
  ```

## Telemetry

Configured on the Duron client:

- `telemetry: { traceExporter }` → export to OTel backends
- No config → disabled

## Key Files

| Path                                              | Description                   |
| ------------------------------------------------- | ----------------------------- |
| `packages/duron/src/client.ts`                    | Job queue client              |
| `packages/duron/src/action.ts`                    | Action definitions            |
| `packages/duron/src/server.ts`                    | REST API server               |
| `packages/duron/src/step-manager.ts`              | Step execution & nested steps |
| `packages/duron/src/adapters/adapter.ts`          | Base adapter                  |
| `packages/duron/src/telemetry/`                   | Telemetry adapters            |
| `packages/duron-dashboard/src/DuronDashboard.tsx` | Dashboard root                |

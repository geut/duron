# Duron Core — Consolidated Audit Findings

**Date:** 2025-06-21
**Commit:** `16c1be2` (feature/active-archive-and-time-travel branch)
**Scope:** `packages/duron/` — core library only (22 source files, ~7K lines)
**Sources:** Three independent audits consolidated — initial code review (`AUDIT.md`), branch review (`duron-active-archive-improvements.md`), and this session's fresh audit with parallel subagents.

---

## How to use this document

Findings are ordered by **leverage = impact ÷ effort, discounted by confidence and fix-risk**. Each finding is tagged with a source origin:

- **`[NEW]`** — discovered in the June 21 fresh audit
- **`[AUDIT]`** — from the initial code audit (`AUDIT.md`, 2025-06-01)
- **`[BRANCH]`** — from the active/archive branch review

---

## Findings

### 1. SQL injection via `groupKey` array filter in REST API

- **Origin:** `[NEW]`
- **Category:** Security
- **Evidence:** `src/adapters/postgres/base.ts:1482` and `:1566` — `sql.raw(filters.groupKey.map((key) => \`'${key}'\`).join(','))`directly interpolates user-controlled strings into a SQL`LIKE ANY(ARRAY[...])`expression.`src/server.ts:109`—`fGroupKey`arrives from HTTP query params and is validated only as`z.union([z.string(), z.array(z.string())])` — no sanitization.
- **Impact:** Any authenticated dashboard user (or anyone when `login` is not configured) can break out of the SQL string literal with a single quote in a group key filter. This enables read/write SQL injection against the Postgres database.
- **Effort:** S — use drizzle's parameterized `sql.join` or `inArray` instead of `sql.raw`.
- **Risk:** LOW — parameterized replacement is a mechanical change.
- **Confidence:** HIGH — the pattern and the API entry point are both clear.
- **Fix sketch:** Replace the `sql.raw` interpolation with a parameterized approach: `sql\`j.group_key = ANY(${filters.groupKey})\``or build individual`eq()`conditions combined with`or()`.

---

### 2. SQL injection via `inputFilter`/`outputFilter` JSONB array values

- **Origin:** `[NEW]`
- **Category:** Security
- **Evidence:** `src/adapters/postgres/base.ts:2282` — `sql.raw(JSON.stringify([arrayValue]))` interpolates a JSON-serialized value into a SQL string literal. `JSON.stringify` does not escape single quotes. `src/server.ts:117` — `fInputFilter`/`fOutputFilter` arrive as `z.record(z.string(), z.any())` with no value-type restrictions.
- **Impact:** An object value containing a single quote in a string property (e.g. `{"a": "it's"}`) breaks out of the SQL literal. Reachable via the same API as finding #1.
- **Effort:** S — use `sql.json()` or parameterized array construction.
- **Risk:** LOW — parameterized replacement is mechanical.
- **Confidence:** HIGH — the pattern is clear; JSON.stringify's single-quote behavior is a known gap.
- **Fix sketch:** Replace `sql.raw(JSON.stringify([arrayValue]))` with `sql.json([arrayValue])` or construct the array with drizzle's parameterized `sql.join`.

---

### 3. Bulk `DELETE /api/jobs` can destroy all running jobs with no status guard

- **Origin:** `[NEW]`
- **Category:** Security
- **Evidence:** `src/adapters/postgres/base.ts:822-830` — `_deleteJobs` builds WHERE clause solely from `_buildJobsWhereClause(filters)` with no status filter. The doc comment at `:817` says "Active jobs will be excluded" but the code does not enforce this. `src/server.ts:610-640` — `DELETE /jobs` accepts all filters as optional query params.
- **Impact:** `DELETE /api/jobs` with no query string wipes every queued and running job via cascade. Irreversible data loss.
- **Effort:** S — add `ne(status, JOB_STATUS_ACTIVE)` guard to `_deleteJobs`.
- **Risk:** LOW — adding a guard only narrows behavior.
- **Confidence:** HIGH — code read; drizzle behavior verified.
- **Fix sketch:** Always AND a `ne(jobsTable.status, JOB_STATUS_ACTIVE)` condition into the where clause, and refuse to run when the resulting where is undefined (or require explicit confirmation flag).

---

### 4. `_retryJob` missing `FOR UPDATE` lock despite comment claiming it exists

- **Origin:** `[AUDIT]`
- **Category:** Correctness
- **Evidence:** `src/adapters/postgres/base.ts:453-555` — the `locked_source` CTE reads the archived job but has no `FOR UPDATE` clause. The JSDoc at `:452` states "Uses SELECT FOR UPDATE to prevent concurrent retries from creating duplicate jobs" — this is false. The `existing_retry` CTE uses a shared snapshot, so two concurrent `_retryJob` calls for the same archived job both see no existing retry and both insert.
- **Impact:** Duplicate jobs created on concurrent retry calls for the same archived job. No unique partial index prevents duplicates.
- **Effort:** S — add `FOR UPDATE` to the source CTE or add a partial unique index on active jobs.
- **Risk:** LOW — adding a lock is additive.
- **Confidence:** HIGH — the code is unambiguous.
- **Fix sketch:** Add `FOR UPDATE` to the `locked_source` CTE's SELECT, or add a unique partial index: `CREATE UNIQUE INDEX ... ON jobs_active (action_name, group_key, checksum, input) WHERE status IN ('created', 'active')`.

---

### 5. `waitForJob` TOCTOU race hangs on fast-completing jobs

- **Origin:** `[AUDIT]`
- **Category:** Correctness
- **Evidence:** `src/client.ts:927-1010` — `getJobStatus()` is called first (await yields to the event loop), then `#setupJobStatusListener()` and the wait registration happen synchronously. If the job completes and the NOTIFY is delivered to the pg driver while `getJobStatus` is in flight (a macrotask gap), the event arrives before the listener is registered and is dropped.
- **Impact:** `waitForJob` and `runActionAndWait` hang indefinitely on fast-completing jobs (no timeout = forever).
- **Effort:** S — register the wait in `#pendingJobWaits` _before_ calling `getJobStatus`, then re-check status.
- **Risk:** LOW — reordering is a local change.
- **Confidence:** HIGH — the race window exists during any `await` gap.
- **Fix sketch:** Register in `#pendingJobWaits` synchronously, then call `getJobStatus`. If terminal, remove the registration and resolve immediately.

---

### 6. `ActionContext` constructor discards Zod-parsed input

- **Origin:** `[AUDIT]`
- **Category:** Correctness
- **Evidence:** `src/step-manager.ts:851-857` — two consecutive assignments:
  ```ts
  this.#input = action.input.parse(job.input, { ... })  // parsed result
  this.#input = job.input ?? {}  // unconditionally overwrites
  ```
- **Impact:** Input validation via Zod is silently discarded. Invalid input reaches action handlers without error. Type safety broken at runtime.
- **Effort:** S — remove the second assignment or wrap in `else`.
- **Risk:** MED — changing validation flow could affect recovered jobs.
- **Confidence:** HIGH — the double-assignment is unambiguous.
- **Fix sketch:** Remove line 857 (`this.#input = job.input ?? {}`).

---

### 7. Step span leaked on recovery of already-completed steps

- **Origin:** `[NEW]`
- **Category:** Correctness
- **Evidence:** `src/step-manager.ts:468-495` — when `#executeStep` is called for a step with `status === STEP_STATUS_COMPLETED`, a new OTel span is created (`:473`), added to `#stepSpans` (`:485`), then the method returns early (`:493`) without calling `stepSpan.end()` or deleting from the map. The `#stepSpans.delete` calls at lines 694 and 782 only fire in the normal/exception paths.
- **Impact:** Each time a step is recovered as already-completed (process restart, time-travel), one span is never ended and one `#stepSpans` entry accumulates — memory leak and orphaned "started but never ended" spans in telemetry storage.
- **Effort:** S — add `stepSpan.end(); this.#stepSpans.delete(step.id)` before the early return.
- **Risk:** LOW — additive cleanup.
- **Confidence:** HIGH — code read confirms the gap.
- **Fix sketch:** Before `return step.output as TResult` on line 493, add: `stepSpan.end(); this.#stepSpans.delete(step.id)`.

---

### 8. Event listeners never removed on `stop()` — duplicated on restart

- **Origin:** `[NEW]`
- **Category:** Correctness
- **Evidence:** `src/client.ts:1265-1283` (`#setupJobStatusListener` adds `database.on('job-status-changed')`), `:1412-1420` (`#setupPushListener` adds `database.on('job-available')`). `src/client.ts:1180-1224` (`stop()`) does not call `removeListener` on the adapter. `#setupJobStatusListener` has a `#jobStatusListenerSetup` guard, but `#setupPushListener` has no guard at all. `stop()` never resets `#jobStatusListenerSetup = false`.
- **Impact:** After `stop()`, the adapter's PostgreSQL LISTEN channel still fires events which call `getJobById()`/`fetch()` on a stopped client. If the client is stopped then started, `#setupPushListener` may register a second listener (duplicate fetch per NOTIFY).
- **Effort:** M — store listener references, remove them in `stop()`, reset `#jobStatusListenerSetup`.
- **Risk:** MED — must ensure listeners are removed before `adapter.stop()` to avoid use-after-close.
- **Confidence:** HIGH — code read confirms no removal path.
- **Fix sketch:** Store listener function references as fields, remove in `stop()` before `database.stop()`, add a guard to `#setupPushListener`.

---

### 9. `stop()` races with in-flight `start()` — tears down incomplete initialization

- **Origin:** `[NEW]`
- **Category:** Correctness
- **Evidence:** `src/client.ts:1148-1150` — `stop()` checks `#stopping || #stopped` but does NOT await `#starting`. `:1155` sets `#stopping` immediately and proceeds to `manager.stop()` / `database.stop()` while `start()` may still be running `recoverJobs()` or `database.start()`.
- **Impact:** Concurrent `stop()` during `start()` can tear down the database connection while it's still being initialized, producing unhandled rejections or inconsistent adapter state.
- **Effort:** S — `await this.#starting` at the top of `stop()` if it's pending.
- **Risk:** MED — must not deadlock; awaiting is sufficient.
- **Confidence:** HIGH — lifecycle gap is clear.
- **Fix sketch:** Add `if (this.#starting) await this.#starting` at the top of `stop()` before proceeding.

---

### 10. Bulk `DELETE /api/jobs` leaves orphan spans

- **Origin:** `[NEW]`
- **Category:** Correctness
- **Evidence:** `src/adapters/postgres/base.ts:822-830` — `_deleteJobs` deletes from `jobsActiveTable` which cascades to `job_steps_active` via FK, but `spans` has no FK to jobs (`schema.ts:159-161` — `job_id: uuid('job_id')` with no `.references()`). Orphan spans persist until the next `_pruneArchive` run with `totalDeleted > 0`.
- **Impact:** After bulk deletion, orphan spans accumulate in the `spans` table and are served by the dashboard API.
- **Effort:** S — add an orphan span cleanup after `_deleteJobs`, or add a FK with cascade.
- **Risk:** LOW — additive cleanup.
- **Confidence:** HIGH — FK absence is clear in schema.
- **Fix sketch:** After the delete in `_deleteJobs`, run the same orphan span cleanup query used in `_pruneArchive`.

---

### 11. `_truncateArchive` leaves orphan spans with no cleanup path

- **Origin:** `[BRANCH]`
- **Category:** Correctness
- **Evidence:** `src/adapters/postgres/base.ts:2442-2450` — `_truncateArchive` truncates `jobs_archive CASCADE` (removing steps) but explicitly does NOT truncate spans (the comment at `:2445` acknowledges this). The orphan cleanup in `_pruneArchive` (`:2421-2438`) only runs when `totalDeleted > 0`, which is always 0 after a truncate (archive is empty).
- **Impact:** After truncation, all spans that belonged to archived jobs become permanent orphans — never cleaned up.
- **Effort:** S — run the orphan span cleanup at the end of `_truncateArchive`.
- **Risk:** LOW — additive cleanup.
- **Confidence:** HIGH — the conditional in `_pruneArchive` is confirmed.
- **Fix sketch:** Add the orphan span DELETE query at the end of `_truncateArchive`.

---

### 12. `_recoverJobs` ping loop may block shutdown

- **Origin:** `[AUDIT]`
- **Category:** Correctness
- **Evidence:** `src/adapters/postgres/base.ts:992-1000` — `while (pongCount.size < result.length && waitForSeconds > 0)` with `await new Promise(resolve => setTimeout(resolve, 1000).unref?.())`. No abort signal or stopped flag checked inside the loop.
- **Impact:** If `stop()` is called while the ping loop is waiting, the process hangs until the timeout expires (up to 5s with default `processTimeout`).
- **Risk is bounded:** `waitForSeconds` is `processTimeout / 1000`, so the delay is finite. Still causes slow shutdown.
- **Effort:** S — check an abort signal or stopped flag inside the loop.
- **Risk:** LOW — additive check.
- **Confidence:** HIGH — the loop structure is confirmed.
- **Fix sketch:** Accept an `AbortSignal` in `_recoverJobs`, check `signal.aborted` inside the while loop condition.

---

### 13. `sql.raw(timeoutMs)` for interval interpolation

- **Origin:** `[AUDIT]`
- **Category:** Security (code smell)
- **Evidence:** `src/adapters/postgres/base.ts:1159` and `:1166` — `now() + interval '${sql.raw(timeoutMs.toString())} milliseconds'`. `timeoutMs` comes from user configuration and is typed as `number`.
- **Impact:** Low practical risk since the type is `number`, but `sql.raw` with user-influenced values is a code smell and harder to audit.
- **Effort:** S — use `sql\`now() + (${timeoutMs} * interval '1 millisecond')\``.
- **Risk:** LOW — parameterized replacement.
- **Confidence:** HIGH on the pattern; LOW risk since it's a number.
- **Fix sketch:** Replace with parameterized arithmetic.

---

### 14. `_timeTravelJob` restore uses fragile field-by-field copy

- **Origin:** `[BRANCH]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/postgres/base.ts:569-587` (job restore) and `:595-615` (step restore) — every column listed explicitly. Compare with `_completeJob`/`_failJob` which use `...job` spread pattern.
- **Impact:** Adding a new column to `jobs_active` will be picked up by archive moves but silently dropped by time-travel restore.
- **Effort:** S — change to `await tx.insert(...).values(job)` and `{ ...s, parallel: s.parallel }` (or just `s` since drizzle maps `parallel` to `branch`).
- **Risk:** LOW — spread is strictly more resilient.
- **Confidence:** HIGH — the pattern difference is confirmed.
- **Fix sketch:** Replace explicit field lists with spread: `{ ...job }` / `{ ...s }`.

---

### 15. `_timeTravelJob` concurrent restore race condition

- **Origin:** `[BRANCH]`
- **Category:** Correctness
- **Evidence:** `src/adapters/postgres/base.ts:559-565` — `archivedJob` select has no `FOR UPDATE`. Two concurrent time-travels of the same job both pass the `archivedJob.length > 0` check and both try to INSERT → PK violation → unhandled transaction error.
- **Impact:** Concurrent time-travel calls for the same job produce unhandled PK errors instead of a graceful no-op.
- **Effort:** S — add `.for('update')` to the select, or use `INSERT ... ON CONFLICT DO NOTHING`.
- **Risk:** LOW — explicit locking or conflict handling is additive.
- **Confidence:** HIGH — the select has no lock.
- **Fix sketch:** Add `.for('update')` to the `archivedJob` select query.

---

### 16. Unused npm dependencies: `p-all` and `p-timeout`

- **Origin:** `[NEW]`
- **Category:** Tech Debt
- **Evidence:** `package.json` lists `"p-all": "^5.0.1"` and `"p-timeout": "^7.0.1"` in `dependencies`. `grep -r "from 'p-all'" src/ test/` and `grep -r "from 'p-timeout'" src/ test/` return zero matches.
- **Impact:** Unnecessary transitive dependencies increase install size and attack surface for the published npm package. Users inherit these deps.
- **Effort:** S — `bun remove p-all p-timeout`.
- **Risk:** LOW — removing unused deps cannot break runtime.
- **Confidence:** HIGH — no imports exist.
- **Fix sketch:** Remove from `package.json` dependencies, run `bun install`, verify build passes.

---

### 17. `step-status-changed` and `step-delayed` NOTIFYs emitted but never listened to

- **Origin:** `[NEW]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/adapter.ts:561,592,623,654` — `completeJobStep`, `failJobStep`, `delayJobStep`, `cancelJobStep` all call `this._notify('step-status-changed', ...)` or `this._notify('step-delayed', ...)`. `src/adapters/postgres/base.ts:126-144` subscribes only to `ping`, `job-status-changed`, and `job-available` — no `_listen` for step events.
- **Impact:** Every step completion/failure/delay generates a PostgreSQL NOTIFY that no one handles — wasted DB work. If step push notifications were intended for consumers, they are silently broken.
- **Effort:** S — either add listeners and emit events, or remove the `_notify` calls.
- **Risk:** LOW — additive or removal of dead code.
- **Confidence:** HIGH — `_listen` calls are enumerated and step events are absent.
- **Fix sketch:** If step push is intended, add `_listen('step-status-changed', ...)` in `_start()` and emit client-side events. If deferred, remove the `_notify` calls.

---

### 18. `_deleteJobs` only operates on active table

- **Origin:** `[AUDIT]`
- **Category:** Correctness
- **Evidence:** `src/adapters/postgres/base.ts:822-830` — `_deleteJobs` deletes only from `jobsActiveTable`. `getJobs` queries both active and archive tables. Users calling `DELETE /api/jobs` with filters may expect all matching jobs (including archived) to be deleted.
- **Impact:** Inconsistent API behavior — bulk delete silently skips archived jobs.
- **Effort:** M — extend to also delete from archive table, or document the limitation.
- **Risk:** MED — extending to archive changes API semantics.
- **Confidence:** HIGH — code confirms active-only.
- **Fix sketch:** Either delete from both tables, or document the behavior in the JSDoc and server route.

---

### 19. `processTimeout` JSDoc mismatch: `@default 5000` but schema default is `500`

- **Origin:** `[AUDIT]`
- **Category:** Docs
- **Evidence:** `src/client.ts:252` — JSDoc says `@default 5000`. `src/client.ts:272` — `z.number().default(500)`. The 500ms default is a deliberate recent decision (commit `16c1be2`).
- **Impact:** Users reading the JSDoc will expect a 5000ms timeout; the actual default is 500ms. This may lead to unexpected false recoveries in multi-process mode.
- **Effort:** S — update JSDoc to `@default 500`.
- **Risk:** LOW — documentation only.
- **Confidence:** HIGH — both values confirmed.
- **Fix sketch:** Change `@default 5000` to `@default 500` in the JSDoc for `processTimeout`.

---

### 20. `serializeError` drops custom properties from plain `Error` instances

- **Origin:** `[AUDIT]`
- **Category:** Correctness
- **Evidence:** `src/errors.ts:347-354` — the `Error` branch serializes only `name`, `message`, `cause`, `stack`. Custom enumerable properties like `code` (common on Node.js errors like `ENOENT`, `ECONNREFUSED`) are dropped.
- **Impact:** When non-DuronError errors are logged or persisted, useful debugging context (`code`, `statusCode`) is lost.
- **Effort:** S — spread enumerable properties into the result.
- **Risk:** LOW — additive serialization.
- **Confidence:** HIGH — the branch is clear.
- **Fix sketch:** In the `Error` branch, add `...Object.fromEntries(Object.entries(error).filter(([k]) => !['name','message','cause','stack'].includes(k)))`.

---

### 21. `base.ts.backup` committed to repository

- **Origin:** `[BRANCH]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/postgres/base.ts.backup` — 1801-line backup file committed to the branch.
- **Impact:** Bloats the repository; risks confusion about which file is canonical.
- **Effort:** S — `git rm` and add `*.backup` to `.gitignore`.
- **Risk:** LOW.
- **Confidence:** HIGH — file confirmed present.

---

### 22. Unused indexes on `jobs_active` (hot-path overhead)

- **Origin:** `[BRANCH]`
- **Category:** Performance
- **Evidence:** `src/adapters/postgres/schema.ts:74` — `idx_jobs_active_output_fts` (GIN on output). Active jobs have `output = NULL` by definition (populated at finish, then moved to archive). `:63` — `idx_jobs_active_started_at` — active jobs have very recent `started_at` (moments ago); a simple `WHERE status = 'active'` covers the same use case.
- **Impact:** Each `UPDATE` on `jobs_active` (the hot path for every job fetch/complete/fail) invalidates index entries for unused indexes — reducing HOT update performance.
- **Effort:** M — remove unused indexes; verify via `pg_stat_user_indexes` before deleting in production.
- **Risk:** MED — removing an index that IS used would regress query performance.
- **Confidence:** HIGH on `output_fts` (always NULL in active); MED on `started_at` (may have dashboard queries).
- **Fix sketch:** Run `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = 'jobs_active'` on a live deployment, remove zero-scan indexes.

---

### 23. `_fetch` `verify_concurrency` CTE re-counts active jobs (redundant)

- **Origin:** `[AUDIT]`
- **Category:** Performance
- **Evidence:** `src/adapters/postgres/base.ts:902-920` — `verify_concurrency` CTE re-counts active jobs per candidate after `eligible_groups` already counted them. Within a single statement's snapshot, the count cannot change.
- **Impact:** Increased query latency at scale (correlated subquery per candidate job).
- **Effort:** S/M — trust the initial count or move re-check to application level.
- **Risk:** LOW — the CTE is defensive; removal is safe within a single-statement snapshot.
- **Confidence:** MED — within a single statement this is redundant, but `FOR UPDATE SKIP LOCKED` row-level locking interacts with EPQ re-evaluation, making this subtle.
- **Fix sketch:** Remove the `verify_concurrency` CTE and rely on `eligible_groups` count, or add a comment explaining why it's needed if EPQ analysis reveals a reason.

---

### 24. Advisory lock key uses djb2 hash of schema name

- **Origin:** `[AUDIT]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/postgres/base.ts:160-167` — `_advisoryLockKey()` uses a djb2 variant to hash the schema name into a 32-bit integer.
- **Impact:** Two different schema names could produce the same hash, causing prune lock contention. Low risk for single-schema deployments.
- **Effort:** S — use a fixed advisory lock key or document the assumption.
- **Risk:** LOW.
- **Confidence:** HIGH — the hash function is simple.
- **Fix sketch:** Document the single-schema assumption, or switch to a fixed lock key (e.g., `42`).

---

### 25. `branch` vs `parallel` naming inconsistency (DB vs API)

- **Origin:** `[AUDIT]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/postgres/schema.ts:90` — DB column is `branch`. TypeScript field is `parallel`. The drizzle mapping is explicit (`boolean('branch').notNull()`) and works correctly.
- **Impact:** Readability confusion when switching between SQL and TypeScript code.
- **Effort:** M — rename the DB column to `parallel` via a migration.
- **Risk:** MED — migration required; external SQL queries may reference `branch`.
- **Confidence:** HIGH — the mapping is confirmed.
- **Fix sketch:** Create a migration that renames the column; update all raw SQL references. Alternatively, leave as-is and document the mapping.

---

### 26. `_cancelJob` updates steps before checking job existence

- **Origin:** `[AUDIT]`
- **Category:** Correctness (trivial)
- **Evidence:** `src/adapters/postgres/base.ts:383-430` — step 1 updates all steps for `jobId`, step 2 checks if the job exists. If the job doesn't exist, 0 rows are updated — harmless but wasteful.
- **Effort:** S — reorder.
- **Risk:** LOW.
- **Confidence:** HIGH.
- **Fix sketch:** Move the job existence check before the step update.

---

### 27. `_getJobSteps` two round-trips to determine table

- **Origin:** `[AUDIT]`, `[BRANCH]`
- **Category:** Performance (low)
- **Evidence:** `src/adapters/postgres/base.ts:1406-1460` — queries `jobs_active` for existence, then queries the appropriate `job_steps_*` table.
- **Impact:** O(N) extra queries for dashboard pages listing many jobs' steps. Both queries are indexed PK/FK lookups — likely a few milliseconds each.
- **Effort:** M — accept a hint parameter or UNION ALL both tables.
- **Risk:** LOW.
- **Confidence:** HIGH on the pattern; LOW priority.
- **Fix sketch:** Accept `{ location?: 'active' | 'archive' }` hint; callers that already know can skip the check.

---

### 28. `waitForAbort` listener never removed, `release()` uses `setTimeout(0)`

- **Origin:** `[AUDIT]`
- **Category:** Correctness (trivial)
- **Evidence:** `src/utils/wait-for-abort.ts` — the `abort` event listener is never cleaned up when `release()` is called. `release()` uses `setTimeout(() => globalResolve?.(), 0)` which is unconventional.
- **Impact:** Listener stays attached after resolution. In practice, signals are short-lived per-step, so no real memory leak. `setTimeout(0)` adds an unnecessary microtask.
- **Effort:** S — remove the listener in `release()`.
- **Risk:** LOW.
- **Confidence:** HIGH.
- **Fix sketch:** Store the listener reference and call `signal.removeEventListener('abort', listener)` in `release()`.

---

### 29. MD5 used for action code checksums

- **Origin:** `[AUDIT]`
- **Category:** Tech Debt (not worth doing)
- **Evidence:** `src/utils/checksum.ts` — `createHash('md5')` for change detection checksums.
- **Impact:** Not a security concern; used purely for detecting code changes between runs. MD5 collisions in code strings are astronomically unlikely.
- **Verdict:** Not worth doing. SHA-256 would be marginally more robust but the practical difference is nil for this use case.

---

### 30. `PruneArchiveOptions.olderThan` type mismatch

- **Origin:** `[NEW]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/schemas.ts` — `PruneArchiveOptionsSchema.olderThan: z.string()`. `src/adapters/postgres/base.ts:2357-2380` — `_parseOlderThan` handles `string | Date | number`.
- **Impact:** API consumers passing a `Date` or `number` to `adapter.pruneArchive()` get a Zod validation error even though the implementation supports it.
- **Effort:** S — widen the schema.
- **Risk:** LOW — widening is backward-compatible.
- **Confidence:** HIGH.
- **Fix sketch:** Change to `z.union([z.string(), z.coerce.date(), z.number()])`.

---

### 31. No `.env.example` documenting required environment variables

- **Origin:** `[NEW]`
- **Category:** DX
- **Evidence:** No `.env*` files exist in `packages/duron/`. Environment variables like `DATABASE_URL`, `JWT_SECRET` are not documented in the package itself.
- **Impact:** New contributors or consumers must dig through examples or docker-compose.
- **Effort:** S — create `.env.example`.
- **Risk:** LOW.
- **Confidence:** HIGH.

---

### 32. `package.json` missing `repository`, `bugs`, `homepage` fields

- **Origin:** `[NEW]`
- **Category:** DX
- **Evidence:** `package.json` has `license: "MIT"` and `name: "duron"` but no `repository`, `bugs`, or `homepage`.
- **Impact:** Poor discoverability on npm; users cannot file issues from the package page.
- **Effort:** S — add three fields.
- **Risk:** LOW.
- **Confidence:** HIGH.

---

### 33. `_initDb()` throws at runtime instead of being abstract

- **Origin:** `[NEW]`
- **Category:** Tech Debt
- **Evidence:** `src/adapters/postgres/base.ts:113-115` — `protected _initDb() { throw new Error('Not implemented') }`. Non-abstract, so a subclass forgetting to override it fails only at runtime.
- **Effort:** S — change to `protected abstract _initDb(): void`.
- **Risk:** LOW — existing subclasses already implement it.
- **Confidence:** HIGH.

---

### 34. `base.ts` is a 2488-line god module

- **Origin:** `[NEW]`
- **Category:** Tech Debt (direction)
- **Evidence:** `src/adapters/postgres/base.ts` — 2488 lines containing job CRUD, step CRUD, fetch with concurrency, recovery with ping/pong, archiving, pruning, spans, query builders, JSONB filters, scheduler. ~10x the next-largest file.
- **Impact:** High cognitive load; any change risks regressions in unrelated areas.
- **Effort:** L — extract into focused modules (jobs, steps, fetch/recovery, archive, spans, scheduler).
- **Risk:** MED — requires careful test coverage verification.
- **Confidence:** HIGH.

---

## Findings considered and rejected

| Finding                                    | Rationale                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_parseOlderThan` doesn't handle all types | Handles `string \| Date \| number` correctly; no bug found                                                                                                                                  |
| `processTimeout` default should be 5000    | 500 is a deliberate recent decision (commit `16c1be2`); only JSDoc is wrong                                                                                                                 |
| MD5 for checksums                          | Not security-sensitive; practical collision risk is nil for code change detection                                                                                                           |
| `_getJobSteps` two round-trips             | Both queries are indexed PK/FK lookups — a few ms; not worth optimizing until profiling shows it matters                                                                                    |
| CORS missing                               | Fail-closed default (no CORS plugin); bearer-header auth means no classic CSRF vector                                                                                                       |
| `as any` type escape hatches               | 33 instances across src — mostly in telemetry and error handling where TS types don't match runtime shapes. Pragmatic for a library with OTel integration. Not worth auditing individually. |

---

## Missing test coverage (cross-reference)

| Gap                                                  | Related finding                         |
| ---------------------------------------------------- | --------------------------------------- |
| Input validation bypass in `ActionContext`           | #6 (ActionContext double-assignment)    |
| `waitForJob` for already-completed jobs              | #5 (TOCTOU race)                        |
| Concurrent `_retryJob` calls                         | #4 (missing FOR UPDATE)                 |
| `_timeTravelJob` with archived jobs                  | #15 (concurrent race)                   |
| Auth/login routes (`/login`, `/refresh`, auth guard) | Not yet tested at all                   |
| Prune scheduler lifecycle                            | No test exercises `pruneArchive` option |
| `_deleteJobs` bulk behavior (no filters)             | #3 (destroys all active jobs)           |
| Step span cleanup on recovery                        | #7 (span leak)                          |
| `stop()` during `start()`                            | #9 (lifecycle race)                     |

---

## Prioritised fix order

**Security first, then correctness, then cleanup:**

1. **#1** — SQL injection in `groupKey` filter (HIGH security, S effort)
2. **#2** — SQL injection in `inputFilter`/`outputFilter` (HIGH security, S effort)
3. **#3** — Bulk DELETE destroys running jobs (HIGH security, S effort)
4. **#4** — `_retryJob` missing FOR UPDATE (HIGH correctness, S effort)
5. **#5** — `waitForJob` TOCTOU race (HIGH correctness, S effort)
6. **#6** — `ActionContext` discards Zod input (HIGH correctness, S effort)
7. **#7** — Step span leak on recovery (MED correctness, S effort)
8. **#8** — Listeners never removed on stop (MED correctness, M effort)
9. **#9** — stop() races with start() (MED correctness, S effort)
10. **#11** — `_truncateArchive` orphan spans (MED correctness, S effort)
11. **#13** — `sql.raw(timeoutMs)` (LOW security smell, S effort)
12. **#14** — Field-by-field time-travel copy (LOW tech debt, S effort)
13. **#16** — Unused `p-all`/`p-timeout` deps (LOW tech debt, S effort)
14. **#19** — processTimeout JSDoc mismatch (LOW docs, S effort)
15. Everything else by effort ratio

**Dependency note:** Findings #1 and #2 should land together (same file area, same fix pattern). #3 and #10 are in the same method (`_deleteJobs`). #8 and #9 are both lifecycle issues in `client.ts` and should be reviewed together.

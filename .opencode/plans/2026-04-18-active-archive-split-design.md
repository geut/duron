# Active/Archive Split for Duron PostgreSQL Adapter

## Date: 2026-04-18

## Status: Design Complete, Pending Implementation

---

## 1. Problem Statement

Duron's PostgreSQL adapter uses the standard **UPDATE + DELETE** pattern for job lifecycle management. Every job creates multiple dead tuples:

- Job creation: INSERT (1 live tuple)
- Job activation: UPDATE status → active (1 dead tuple)
- Job completion/failure: UPDATE status + timestamps (1-2 dead tuples)
- With retries: additional UPDATEs for status, retries_count, history_failed_attempts

Under sustained load (thousands of jobs/sec), this creates:

1. **Table bloat** — Dead tuples accumulate faster than autovacuum can clean them
2. **Index bloat** — All ~15 indexes on the jobs table need maintenance on every UPDATE
3. **Performance decay** — Queries slow down as tables/indexes grow
4. **Autovacuum pressure** — Vacuum must scan entire table (including millions of completed jobs) just to reclaim a few dead tuples

The problem is well-documented in the Postgres queue ecosystem:
- Brandur/Heroku (2015): 60k backlog in one hour
- PlanetScale (2026): Death spiral at 800 jobs/sec
- River issue #59: Autovacuum starvation

### What Duron Does Right

- Short transactions: No explicit transactions wrapping job handlers
- Correct SKIP LOCKED usage for worker contention
- Atomic single-query CTEs for operations

### What Duron Does Not Have

- No automatic retention — completed jobs accumulate indefinitely
- All jobs share the same table — hot path indexes scan through historical entries
- UPDATE-heavy patterns create constant pressure on autovacuum

---

## 2. Proposed Solution: Active/Archive Split

Split the schema into **active** (live work) and **archive** (terminated work) tables. The hot path operates exclusively on small, bounded active tables. Archive tables grow with historical volume but don't affect live operations.

### 2.1 Core Principles

1. **Hot path isolation** — Active tables contain only jobs in `created` or `active` status. Their size is proportional to in-flight work, not historical volume.
2. **Single move per job** — A job moves from active to archive exactly once, at termination (completed/failed/cancelled). No per-state-transition moves.
3. **Archive is INSERT-only** — Archive tables receive almost exclusively INSERTs. Their natural dead tuple generation is minimal.
4. **No critical scripts** — No background workers, no partition creation scripts, no extension dependencies.
5. **User-controlled retention** — Pruning is explicit and bounded. Users opt in via configuration.

---

## 3. Schema Design

### 3.1 New Tables

#### `jobs_active`

Same schema as current `jobs` table, but contains **only non-terminal jobs** (status IN `created`, `active`).

**Indexes (all needed for hot-path queries):**
- `idx_jobs_active_action_name`
- `idx_jobs_active_status`
- `idx_jobs_active_group_key`
- `idx_jobs_active_started_at`
- `idx_jobs_active_expires_at`
- `idx_jobs_active_client_id`
- `idx_jobs_active_checksum`
- `idx_jobs_active_concurrency_limit`
- `idx_jobs_active_concurrency_step_limit`
- `idx_jobs_active_action_status` (composite)
- `idx_jobs_active_action_group` (composite)
- `idx_jobs_active_input_fts` (GIN full-text)
- `idx_jobs_active_output_fts` (GIN full-text)

#### `jobs_archive`

Same columns as `jobs_active`, but contains **only terminal jobs** (status IN `completed`, `failed`, `cancelled`).

**Indexes (optimized for lookup and search, skip hot-path-only indexes):**
- `idx_jobs_archive_id` (primary key)
- `idx_jobs_archive_group_key`
- `idx_jobs_archive_action_name`
- `idx_jobs_archive_finished_at`
- `idx_jobs_archive_action_group` (composite)
- `idx_jobs_archive_input_fts` (GIN full-text) — **Kept for dashboard search**
- `idx_jobs_archive_output_fts` (GIN full-text) — **Kept for dashboard search**

**Dropped indexes (not needed for archive queries):**
- `status` — all archive jobs are terminal
- `client_id` — not relevant for historical jobs
- `expires_at` — not relevant for terminated jobs
- `started_at` — less relevant than `finished_at`
- `concurrency_limit` / `concurrency_step_limit` — not relevant
- `description` — covered by FTS indexes
- `checksum` — not relevant for historical lookups

**Design note:** No UNIQUE constraints that would prevent user-added partitioning. The archive schema is partition-friendly.

#### `job_steps_active`

Same schema as current `job_steps`. FK to `jobs_active.id` with `ON DELETE CASCADE`.

**Indexes (hot-path):**
- `idx_job_steps_active_job_id`
- `idx_job_steps_active_status`
- `idx_job_steps_active_name`
- `idx_job_steps_active_expires_at`
- `idx_job_steps_active_parent_step_id`
- `idx_job_steps_active_job_status` (composite)
- `idx_job_steps_active_job_name` (composite)
- `unique_job_step_active_name_parent` (unique constraint)

#### `job_steps_archive`

Same columns as `job_steps_active` **plus** denormalized `job_finished_at` column (copied from parent job at archival time for easier time-based pruning).

**No FK constraints** — enables future user partitioning.

**Indexes (minimal):**
- `idx_job_steps_archive_id` (primary key)
- `idx_job_steps_archive_job_id`
- `idx_job_steps_archive_job_finished_at`
- `idx_job_steps_archive_name`

#### `spans_active`

Same schema as current `spans`. FKs to `jobs_active.id` and `job_steps_active.id` with `ON DELETE CASCADE`.

**Indexes:**
- `idx_spans_active_trace_id`
- `idx_spans_active_span_id`
- `idx_spans_active_job_id`
- `idx_spans_active_step_id`
- `idx_spans_active_name`
- `idx_spans_active_job_step` (composite)
- `idx_spans_active_trace_parent` (composite)
- `idx_spans_active_attributes` (GIN)
- `idx_spans_active_events` (GIN)

#### `spans_archive`

Same columns as `spans_active`.

**No FK constraints** — enables future user partitioning.

**Indexes (minimal):**
- `idx_spans_archive_id` (primary key)
- `idx_spans_archive_trace_id`
- `idx_spans_archive_job_id`
- `idx_spans_archive_step_id`

### 3.2 Lifecycle Flow

```
CREATE: INSERT INTO jobs_active
        INSERT INTO job_steps_active
        INSERT INTO spans_active (if telemetry enabled)

ACTIVATE: UPDATE jobs_active SET status = 'active', ...

COMPLETE/FAIL/CANCEL: BEGIN TRANSACTION
    1. DELETE FROM jobs_active WHERE id = $1 RETURNING *
    2. DELETE FROM job_steps_active WHERE job_id = $1 RETURNING *
    3. DELETE FROM spans_active WHERE job_id = $1 RETURNING *
    4. INSERT INTO jobs_archive SELECT * FROM step_1
    5. INSERT INTO job_steps_archive 
       SELECT *, $finished_at AS job_finished_at FROM step_2
    6. INSERT INTO spans_archive SELECT * FROM step_3
    COMMIT

RETRY: INSERT INTO jobs_active (copy of failed job)
       INSERT INTO job_steps_active (copy of failed steps)
```

### 3.3 Why Not Partition the Archive?

Time-range partitioning requires a script that creates future partitions ahead of time. Postgres does NOT auto-create partitions. This violates our "no critical scripts" principle.

Mitigations evaluated:
- **DEFAULT partition**: Catches stray INSERTs but accumulates and loses partitioning benefit
- **Create many partitions in advance**: Still requires a script
- **pg_partman**: Requires extension installation, not available on all managed providers
- **Hash partitioning**: Creates partitions once, but loses ability to drop old partitions by time

**Decision:** Go with active/archive split **WITHOUT** partitioning the archive. The archive receives almost exclusively INSERTs. Its natural bloat is minimal. Retention is a periodic admin operation, not a hot-path concern. Users at extreme scale can add partitioning on top without Duron changes.

---

## 4. Adapter Changes

### 4.1 Modified Methods

#### `_createJob`
- **Change:** INSERT into `jobs_active` instead of `jobs`
- **Logic:** Unchanged except for table name

#### `_completeJob` / `_failJob` / `_cancelJob`
- **Change:** MOVE from active to archive instead of UPDATE
- **Logic:** 
  1. DELETE from `jobs_active` WHERE id = $1 AND status = 'active' RETURNING *
  2. DELETE from `job_steps_active` WHERE job_id = $1 RETURNING *
  3. DELETE from `spans_active` WHERE job_id = $1 RETURNING *
  4. INSERT into `jobs_archive` SELECT * FROM step_1
  5. INSERT into `job_steps_archive` SELECT *, $finished_at FROM step_2
  6. INSERT into `spans_archive` SELECT * FROM step_3
- **Transaction:** All steps in single atomic transaction
- **Failure handling:** If DELETE from active fails (job not found or not active), entire transaction rolls back

#### `_fetch`
- **Change:** Query `jobs_active` only
- **Logic:** Unchanged except for table name
- **Benefit:** No scanning through historical jobs

#### `_recoverJobs`
- **Change:** Query `jobs_active` only
- **Logic:** Already only touches active jobs, just table name change

#### `_retryJob`
- **Change:** Query `jobs_archive` (for source job) and INSERT into `jobs_active`
- **Logic:** Failed jobs are archived immediately, so retry reads from archive and copies back to active

#### `_deleteJob` / `_deleteJobs`
- **Change:** Delete from appropriate table based on status filter
- **Logic:** 
  - If status filter includes only active statuses → delete from `jobs_active`
  - If status filter includes only archive statuses → delete from `jobs_archive`
  - If mixed or no filter → delete from both (two queries)

#### `_getJobById`
- **Change:** Query `jobs_active` first, then `jobs_archive` on miss
- **Optimization:** Active table is tiny, miss is fast

#### `_getJobs`
- **Change:** Route based on status filter
- **Logic:**
  - Status = `created` or `active` only → query `jobs_active`
  - Status = `completed`, `failed`, `cancelled` only → query `jobs_archive`
  - Mixed or no status filter → `UNION ALL` between both tables
  - Time-range filters on `finished_at` should bias to `jobs_archive`

**All existing filters are applied to both tables in UNION queries:**
- `status`, `actionName`, `groupKey`
- `clientId`, `description`
- `createdAt`, `startedAt`, `finishedAt`, `updatedAfter`
- `inputFilter`, `outputFilter`
- Full-text search via GIN indexes

#### `_getJobSteps`
- **Change:** Route based on job location
- **Logic:** If job is in `jobs_active`, query `job_steps_active`. If in `jobs_archive`, query `job_steps_archive`.

#### `_getJobStepById`
- **Change:** Query `job_steps_active` first, then `job_steps_archive`
- **Logic:** Same pattern as `_getJobById`

#### `_getActions`
- **Change:** Query both tables
- **Logic:** `UNION ALL` between `jobs_active` and `jobs_archive`, group by action_name

#### `_insertSpans` / `_getSpans` / `_deleteSpans`
- **Change:** Route based on job location
- **Logic:** If job/step is active → `spans_active`. If archived → `spans_archive`.
- **Simplification:** For `_getSpans`, if jobId/stepId not provided, query both tables with `UNION ALL`.

### 4.2 New Methods

#### `pruneArchive(options)`

**Signature:**
```typescript
interface PruneArchiveOptions {
  olderThan: string | Date | number  // '30d', Date object, or milliseconds
  batchSize?: number                // Default: 10000
  maxBatches?: number               // Default: 100 (safety limit)
}

async pruneArchive(options: PruneArchiveOptions): Promise<number>
```

**Behavior:**
1. Calculate threshold date from `olderThan`
2. Loop:
   a. DELETE FROM `jobs_archive` WHERE finished_at < $threshold LIMIT $batchSize RETURNING id
   b. DELETE FROM `job_steps_archive` WHERE job_id IN (returned ids)
   c. DELETE FROM `spans_archive` WHERE job_id IN (returned ids)
   d. Count deleted jobs
   e. Repeat until no more rows or maxBatches reached
3. Return total count of deleted jobs

**Transaction:** Each batch is a separate transaction (to avoid long-running transactions).

#### `truncateArchive()`

**Signature:**
```typescript
async truncateArchive(): Promise<void>
```

**Behavior:**
1. TRUNCATE `jobs_archive`
2. TRUNCATE `job_steps_archive`
3. TRUNCATE `spans_archive`

**Safety:** No confirmation required (programmatic API assumes caller knows what they're doing). Dashboard UI will show confirmation dialog.

#### `getArchiveStats()`

**Signature:**
```typescript
interface ArchiveStats {
  jobsCount: number
  stepsCount: number
  spansCount: number
  oldestJobDate: Date | null
  totalSizeBytes: number | null  // May not be available on all adapters
  lastPrunedAt: Date | null
}

async getArchiveStats(): Promise<ArchiveStats>
```

### 4.3 Scheduler Configuration

**Adapter options:**
```typescript
interface PostgresAdapterOptions {
  // ... existing options ...
  
  pruneArchive?: {
    intervalMs: number      // How often to run prune (e.g., 3600000 = 1 hour)
    olderThan: string | Date | number  // Delete jobs older than this
    batchSize?: number      // Default: 10000
    maxBatches?: number     // Default: 100
  }
}
```

**Example:**
```typescript
const adapter = new PostgresAdapter({
  connectionString: 'postgres://...',
  pruneArchive: {
    intervalMs: 3600000,    // Every hour
    olderThan: '30d',       // Delete jobs older than 30 days
    batchSize: 10000,
    maxBatches: 100,
  }
})
```

### 4.4 Multi-Process Safety

**Problem:** Multiple Duron processes running the scheduler. We don't want all of them pruning simultaneously.

**Solution:**

**PostgreSQL:** Advisory locks (`pg_advisory_lock`)
- Before pruning, try to acquire advisory lock on a well-known ID (e.g., hash of 'duron-prune-archive')
- If lock acquired, run prune. If not, skip this cycle.
- Lock is automatically released when session ends (even if process crashes)
- Zero dead tuple pressure

**PGLite:** No multi-process safety needed
- PGLite is embedded/single-process by design
- Multiple PGLite instances don't share the same database file concurrently

**Existing recovery mechanism:** Unchanged (ping/pong via NOTIFY/LISTEN)

### 4.5 Query Examples

**Move job to archive:**
```sql
BEGIN;

WITH moved_job AS (
  DELETE FROM duron.jobs_active 
  WHERE id = $1 
  RETURNING *
),
moved_steps AS (
  DELETE FROM duron.job_steps_active 
  WHERE job_id = $1 
  RETURNING *
),
moved_spans AS (
  DELETE FROM duron.spans_active 
  WHERE job_id = $1 
  RETURNING *
),
inserted_job AS (
  INSERT INTO duron.jobs_archive 
  SELECT * FROM moved_job
  RETURNING finished_at
)
INSERT INTO duron.job_steps_archive 
SELECT ms.*, ij.finished_at AS job_finished_at 
FROM moved_steps ms, inserted_job ij;

INSERT INTO duron.spans_archive 
SELECT * FROM moved_spans;

COMMIT;
```

**Prune archive batch:**
```sql
WITH deleted_jobs AS (
  DELETE FROM duron.jobs_archive 
  WHERE finished_at < $1 
  LIMIT $2 
  RETURNING id
),
deleted_steps AS (
  DELETE FROM duron.job_steps_archive 
  WHERE job_id IN (SELECT id FROM deleted_jobs)
),
deleted_spans AS (
  DELETE FROM duron.spans_archive 
  WHERE job_id IN (SELECT id FROM deleted_jobs)
)
SELECT COUNT(*) FROM deleted_jobs;
```

---

## 5. REST API Design

### 5.1 Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/archive/prune` | POST | Admin | Trigger manual prune |
| `/api/archive/truncate` | POST | Admin | Truncate entire archive |
| `/api/archive/stats` | GET | Read | Get archive statistics |
| `/api/archive/status` | GET | Read | Read-only: current auto-prune config and next scheduled run |

### 5.2 Request/Response Examples

**POST /api/archive/prune**
```json
// Request (optional — uses startup config if omitted)
{
  "olderThan": "7d",
  "batchSize": 5000
}

// Response
{
  "deletedJobs": 15432,
  "deletedSteps": 42389,
  "deletedSpans": 89123,
  "batchesRun": 2,
  "durationMs": 1245
}
```

**POST /api/archive/truncate**
```json
// Request
{
  "confirm": true  // Required to prevent accidental calls
}

// Response
{
  "success": true,
  "deletedJobs": 154320,
  "deletedSteps": 423891,
  "deletedSpans": 891234
}
```

**GET /api/archive/stats**
```json
{
  "jobsCount": 154320,
  "stepsCount": 423891,
  "spansCount": 891234,
  "oldestJobDate": "2026-01-15T10:30:00Z",
  "totalSizeBytes": 104857600,
  "lastPrunedAt": "2026-04-18T02:00:00Z"
}
```

**GET /api/archive/status**
```json
{
  "autoPruneEnabled": true,
  "config": {
    "intervalMs": 3600000,
    "olderThan": "30d",
    "batchSize": 10000,
    "maxBatches": 100
  },
  "nextRunAt": "2026-04-18T03:00:00Z",
  "lastRunAt": "2026-04-18T02:00:00Z",
  "lastRunResult": {
    "deletedJobs": 5421,
    "batchesRun": 1
  }
}
```

---

## 6. Dashboard UI Design

### 6.1 Job List View

**Default view: "Live Jobs"**
- Queries `jobs_active` only
- Fast, no UNION needed
- Shows jobs with status `created` or `active`

**Archive Tab**
- Queries `jobs_archive` directly
- Shows jobs with status `completed`, `failed`, or `cancelled`
- All filters applied to archive table

**"All Jobs" Toggle**
- Uses optimized UNION query
- Applies filters to both tables
- Clearly labeled as potentially slower
- Pagination uses optimized CTE approach:
  ```sql
  WITH active_filtered AS (
    SELECT * FROM jobs_active 
    WHERE [filters applied]
    ORDER BY created_at DESC 
    LIMIT [page_size + offset]
  ),
  archive_filtered AS (
    SELECT * FROM jobs_archive 
    WHERE [filters applied]
    ORDER BY created_at DESC 
    LIMIT [page_size + offset]
  )
  SELECT * FROM active_filtered
  UNION ALL
  SELECT * FROM archive_filtered
  ORDER BY created_at DESC
  LIMIT [page_size] OFFSET [offset]
  ```

**All existing filters work across both tables:**
- `status` — routes to appropriate table when possible
- `actionName`, `groupKey`, `clientId`
- `description` — full-text search via GIN indexes on both tables
- `createdAt`, `startedAt`, `finishedAt`, `updatedAfter`
- `inputFilter`, `outputFilter`

### 6.2 Archive Management Page (`/archive`)

**Components:**
- **Statistics Cards** — Jobs count, steps count, spans count, storage size, oldest record
- **Manual Prune Button** — Opens confirmation dialog, triggers prune API
- **Truncate Button** — Opens strong confirmation dialog (type "DELETE ALL" to confirm), triggers truncate API
- **Configuration Display** — Read-only display of current auto-prune configuration (from startup options)
- **Recent Activity Log** — Table showing recent prune operations (timestamp, jobs deleted, duration)
- **Storage Chart** — Line chart showing archive size over time (if metrics available)

### 6.3 Integration Points

- Add "Archive" link to main navigation
- Archive stats shown on dashboard home (optional)
- Settings page shows read-only prune configuration
- Job list has clear "Live" / "Archive" / "All" tabs

---

## 7. Migration Strategy

### 7.1 Breaking Change

This is a **breaking change** for v1.0. No backward compatibility.

**Rationale:** Duron is not v1 ready. Users must run migration on upgrade.

### 7.2 Migration Steps

1. **Create new tables:**
   - `jobs_active`, `jobs_archive`
   - `job_steps_active`, `job_steps_archive`
   - `spans_active`, `spans_archive`

2. **Migrate existing data:**
   - Jobs with status IN (`created`, `active`) → `jobs_active`
   - Jobs with status IN (`completed`, `failed`, `cancelled`) → `jobs_archive`
   - Steps follow their parent job
   - Spans follow their parent job

3. **Create indexes** on new tables

4. **Drop old tables:** `jobs`, `job_steps`, `spans`

5. **Update application code:**
   - `schema.ts` — Define new tables
   - `schema.default.ts` — Export new tables
   - `base.ts` — Update all adapter methods
   - `server.ts` — Add archive endpoints
   - Dashboard — Add archive page

### 7.3 Rollback

No automatic rollback. Users should backup database before migration.

---

## 8. Testing Strategy

### 8.1 Unit Tests (Adapter)

- Create job → verify in `jobs_active`
- Complete job → verify moved to `jobs_archive`
- Fail job → verify moved to `jobs_archive`
- Cancel job → verify moved to `jobs_archive`
- Retry job → verify copied from archive to active
- Fetch jobs → verify only queries `jobs_active`
- Get job by ID → verify queries both tables
- Get jobs with status filter → verify routing
- Get jobs with mixed status → verify UNION query
- Get jobs with all filters → verify filters applied to both tables in UNION
- Prune archive → verify deletion with batching
- Truncate archive → verify all data removed
- Multi-process safety → verify advisory locks work

### 8.2 Integration Tests

- End-to-end job lifecycle (create → activate → complete → verify archive)
- Multi-worker scenario (concurrent job processing)
- Recovery scenario (process crash, job recovery)
- Archive pruning under load
- Dashboard API integration
- Full-text search on archive

### 8.3 Performance Tests

- Benchmark: Hot path latency (fetch + activate + complete) with 0, 1M, 10M archived jobs
- Verify active table size stays bounded regardless of archive size
- Benchmark: Prune operation performance (various batch sizes)
- Benchmark: UNION query performance with filters (various archive sizes)

---

## 9. What We're NOT Building

To keep scope focused, these are explicitly out of scope:

1. **No automatic partition creation** — Users can add partitioning on top if needed
2. **No pg_partman dependency** — Works on vanilla Postgres
3. **No internal cron/background worker** — Scheduler is opt-in adapter option only
4. **No retention on active tables** — Archive only. Active jobs stay until completed/failed/cancelled
5. **No heartbeat table or lease table** — Multi-process safety via advisory locks (Postgres) or not needed (PGLite)
6. **No dynamic configuration** — All config set at startup, no runtime changes
7. **No archive compression** — Future enhancement if needed
8. **No cross-table foreign keys** — Archive tables have no FKs (by design, for partitioning flexibility)

---

## 10. Tradeoffs

### 10.1 Accepted Tradeoffs

1. **Code complexity** — Adapter increases by ~30-40% LOC. Query routing adds complexity.
2. **Query overhead** — `getJob(id)` does up to 2 lookups (active first, then archive). Mitigated: active table is tiny, miss is fast.
3. **UNION ALL** — Queries spanning live and historical jobs need `UNION ALL`. Only affects dashboard/historical queries, not hot path.
4. **Migration burden** — Existing users must run one-off migration script.
5. **No FKs on archive** — Referential integrity not enforced between archive tables. Acceptable: archive is read-mostly, data is copied in single transaction.

### 10.2 Benefits

1. **Hot path isolation** — Active table size proportional to in-flight work, NOT historical volume. Always small.
2. **Fast autovacuum** — Vacuum on `jobs_active` completes in microseconds.
3. **Small indexes** — Hot-path indexes remain small and cacheable in memory.
4. **Archive doesn't affect live ops** — Archive grows linearly with throughput but doesn't affect job processing.
5. **User-controlled retention** — Explicit, bounded, admin operation. User controls when and how much to prune.
6. **No operational overhead** — No critical scripts, no dependencies, no background processes.
7. **Extensible** — Users at extreme scale can add partitioning on top without Duron changes.
8. **Significant improvement** — Major performance improvement over current design at scale, minimal complexity cost at small scale.

---

## 11. Relation to Dead Letter Queue

The active/archive split is a **storage/performance** concern. A Dead Letter Queue (DLQ) is a **semantic/operational** concern (what happens to messages that fail terminally, so a human can inspect them).

They are **orthogonal**. Duron's current `status = 'failed'` effectively serves as a logical DLQ — failed jobs remain visible and queryable. This can coexist with active/archive: jobs are split by "alive vs terminated", and within the archive, status still distinguishes success from failure.

---

## 12. Comparison with Alternatives

### 12.1 Table-per-state (Rejected)

Split into `jobs_created`, `jobs_active`, `jobs_completed`, `jobs_failed`.

**Pros:** Hot tables stay small.
**Cons:**
- Job with 3 retries moves between tables 7+ times
- Foreign keys become impossible or ugly
- Multi-table transactions needed for every state change
- Large code complexity increase
- **Verdict:** Elegant in concept, too expensive in practice.

### 12.2 Time-range Partitioning (Rejected as primary solution)

Partition `jobs` by `created_at` (e.g., daily).

**Pros:**
- Retention by DROP TABLE (no dead tuples, instant)
- Partition pruning on time-range queries
- Code almost unchanged

**Cons:**
- Current day's partition still contains mixed live/completed jobs
- Still generates UPDATE pressure on the active partition
- Hot partition is still hot
- Requires partition creation scripts (violates "no critical scripts" principle)

**Verdict:** Good for archive retention, but doesn't solve the hot-path bloat problem.

### 12.3 PgQue-style TRUNCATE Rotation (Considered)

Use snapshot-based batching with TRUNCATE table rotation (like pgque/PgQ).

**Pros:**
- Zero dead tuples by design
- No UPDATE pressure at all
- Battle-tested at Skype scale

**Cons:**
- Fundamentally different architecture (event queue vs job queue)
- Would require redesigning Duron's entire job lifecycle model
- PgQue is an event queue with fan-out; Duron is a job queue with steps and retries
- Much larger architectural change

**Verdict:** Wrong tool for the problem. PgQue solves event queue bloat; Duron needs job queue bloat solution. Active/archive split is the right granularity for Duron's use case.

---

## 13. Implementation Order

1. **Phase 1: Schema & Migration**
   - Update `schema.ts` with new table definitions
   - Create Drizzle migration
   - Update `schema.default.ts`

2. **Phase 2: Adapter Core**
   - Modify `_createJob`, `_completeJob`, `_failJob`, `_cancelJob`
   - Implement move-to-archive logic
   - Update `_fetch`, `_recoverJobs`
   - Update query methods (`_getJobById`, `_getJobs`, `_getJobSteps`, etc.)

3. **Phase 3: Archive API**
   - Implement `pruneArchive()`, `truncateArchive()`, `getArchiveStats()`
   - Add scheduler with multi-process safety

4. **Phase 4: REST API**
   - Add archive endpoints to `server.ts`
   - Add authentication/authorization

5. **Phase 5: Dashboard**
   - Create archive management page
   - Update job list with Live/Archive/All tabs
   - Add navigation and components

6. **Phase 6: Testing**
   - Update existing tests
   - Add archive-specific tests
   - Performance benchmarks

7. **Phase 7: Documentation**
   - Update README
   - Add migration guide
   - Add "Managing the archive" section

---

## 14. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration data loss | Low | Critical | Require backup before migration. Test migration thoroughly. |
| Archive move fails mid-transaction | Low | High | Single atomic transaction for move. Rollback on failure. |
| Prune deletes wrong data | Low | Critical | Configurable `olderThan` with sensible default. Batch deletes with LIMIT. |
| Multi-process prune collision | Medium | Low | Advisory locks prevent concurrent pruning. |
| Active table still grows | Medium | Medium | Monitor active table size. If jobs stay active too long, investigate stuck jobs. |
| Query routing bugs | Medium | Medium | Comprehensive tests for all query methods. |
| Dashboard UNION query slow | Low | Low | Optimized CTE approach. "Live Jobs" is default view. |
| Full-text search on archive slow | Low | Low | GIN indexes kept on archive tables. |

---

## 15. Success Criteria

1. **Performance:** Hot path latency (fetch → activate → complete) does not degrade as archive grows from 0 to 10M jobs
2. **Correctness:** All existing tests pass with new schema
3. **Archive functionality:** `pruneArchive()` correctly deletes old jobs in batches
4. **Multi-process safety:** Only one process prunes at a time
5. **Dashboard:** Archive management page shows stats and allows manual prune/truncate
6. **Job list:** Live/Archive/All tabs work with all existing filters
7. **Full-text search:** Search works on both active and archive jobs
8. **Migration:** One-off migration script successfully migrates existing data

---

*End of Design Document*

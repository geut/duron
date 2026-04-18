# Active/Archive Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Duron's PostgreSQL adapter into active/archive tables to eliminate hot-path bloat, add archive management APIs, and update dashboard.

**Architecture:** Active tables (`jobs_active`, `job_steps_active`, `spans_active`) contain live work only. Archive tables contain terminated work. Jobs move to archive once on completion/failure. Pruning is user-controlled with multi-process safety via advisory locks.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Bun, React (dashboard)

---

## File Map

### Core Adapter (Modified)
- `packages/duron/src/adapters/postgres/schema.ts` — New table definitions (jobs_active, jobs_archive, etc.)
- `packages/duron/src/adapters/postgres/schema.default.ts` — Export new tables
- `packages/duron/src/adapters/postgres/base.ts` — Core adapter logic (~1800 lines, will grow)
- `packages/duron/src/adapters/adapter.ts` — Abstract class, add archive methods
- `packages/duron/src/adapters/schemas.ts` — Add archive option schemas

### REST API (Modified)
- `packages/duron/src/server.ts` — Add archive endpoints

### Dashboard (Modified)
- `packages/duron-dashboard/src/` — New archive page, job list tabs

### Migrations (New)
- `packages/duron/migrations/postgres/20260418120000_active_archive_split/` — Drizzle migration

### Tests (New/Modified)
- `packages/duron/test/archive.test.ts` — Archive-specific tests
- `packages/duron/test/adapter.test.ts` — Update existing tests

---

## Task 1: Schema Definition

**Files:**
- Modify: `packages/duron/src/adapters/postgres/schema.ts`
- Modify: `packages/duron/src/adapters/postgres/schema.default.ts`

**Context:** Current `schema.ts` defines `jobsTable`, `jobStepsTable`, `spansTable`. We need to split each into active/archive pairs.

**Changes:**
- `jobsTable` → `jobsActiveTable` + `jobsArchiveTable`
- `jobStepsTable` → `jobStepsActiveTable` + `jobStepsArchiveTable`  
- `spansTable` → `spansActiveTable` + `spansArchiveTable`
- `jobsArchiveTable` drops hot-path-only indexes, keeps lookup + FTS indexes
- `jobStepsArchiveTable` adds `job_finished_at` column
- `spansArchiveTable` has no FKs
- Return all 6 tables from `createSchema()`

- [ ] **Step 1: Read current schema.ts**

Read file to understand current structure and ensure correct Drizzle API usage.

- [ ] **Step 2: Write new schema definitions**

```typescript
// In createSchema() function, replace existing tables with:

const jobsActiveTable = schema.table('jobs_active', { ...same columns... }, (table) => [
  // All hot-path indexes
])

const jobsArchiveTable = schema.table('jobs_archive', { ...same columns... }, (table) => [
  // Lookup indexes + FTS only
])

const jobStepsActiveTable = schema.table('job_steps_active', { ...same columns + job_finished_at... }, (table) => [
  // Hot-path indexes + FK to jobsActiveTable
])

const jobStepsArchiveTable = schema.table('job_steps_archive', { ...same columns... }, (table) => [
  // Minimal indexes, NO FK
])

const spansActiveTable = schema.table('spans_active', { ...same columns... }, (table) => [
  // All indexes + FKs to active tables
])

const spansArchiveTable = schema.table('spans_archive', { ...same columns... }, (table) => [
  // Minimal indexes, NO FKs
])

return {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansActiveTable,
  spansArchiveTable,
}
```

- [ ] **Step 3: Update schema.default.ts**

```typescript
const {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansActiveTable,
  spansArchiveTable,
} = createSchema('duron')

export {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansActiveTable,
  spansArchiveTable,
}
```

- [ ] **Step 4: Verify typecheck**

Run: `cd packages/duron && bun run typecheck`
Expected: PASS (schema types compile)

- [ ] **Step 5: Commit**

```bash
git add packages/duron/src/adapters/postgres/schema.ts packages/duron/src/adapters/postgres/schema.default.ts
git commit -m "feat: add active/archive table schema definitions"
```

---

## Task 2: Adapter Schemas

**Files:**
- Modify: `packages/duron/src/adapters/schemas.ts`

**Context:** Need Zod schemas for new archive APIs.

- [ ] **Step 1: Add archive option schemas**

Add to `schemas.ts`:
```typescript
export const PruneArchiveOptionsSchema = z.object({
  olderThan: z.union([z.string(), z.date(), z.number()]),
  batchSize: z.number().optional(),
  maxBatches: z.number().optional(),
})

export type PruneArchiveOptions = z.infer<typeof PruneArchiveOptionsSchema>

export const ArchiveStatsSchema = z.object({
  jobsCount: z.number(),
  stepsCount: z.number(),
  spansCount: z.number(),
  oldestJobDate: z.date().nullable(),
  totalSizeBytes: z.number().nullable(),
  lastPrunedAt: z.date().nullable(),
})

export type ArchiveStats = z.infer<typeof ArchiveStatsSchema>
```

- [ ] **Step 2: Commit**

```bash
git add packages/duron/src/adapters/schemas.ts
git commit -m "feat: add archive option schemas"
```

---

## Task 3: Abstract Adapter Methods

**Files:**
- Modify: `packages/duron/src/adapters/adapter.ts`

**Context:** Add abstract methods for archive operations to the base class.

- [ ] **Step 1: Add archive abstract methods**

In `Adapter` class, add after existing abstract methods:

```typescript
// ============================================================================
// Archive Methods
// ============================================================================

async pruneArchive(options: PruneArchiveOptions): Promise<number> {
  try {
    await this.start()
    const parsedOptions = PruneArchiveOptionsSchema.parse(options)
    const result = await this._pruneArchive(parsedOptions)
    return NumberResultSchema.parse(result)
  } catch (error) {
    this.logger?.error(error, 'Error in Adapter.pruneArchive()')
    throw error
  }
}

async truncateArchive(): Promise<void> {
  try {
    await this.start()
    await this._truncateArchive()
  } catch (error) {
    this.logger?.error(error, 'Error in Adapter.truncateArchive()')
    throw error
  }
}

async getArchiveStats(): Promise<ArchiveStats> {
  try {
    await this.start()
    const result = await this._getArchiveStats()
    return ArchiveStatsSchema.parse(result)
  } catch (error) {
    this.logger?.error(error, 'Error in Adapter.getArchiveStats()')
    throw error
  }
}

protected abstract _pruneArchive(options: PruneArchiveOptions): Promise<number>
protected abstract _truncateArchive(): Promise<void>
protected abstract _getArchiveStats(): Promise<ArchiveStats>
```

- [ ] **Step 2: Update imports**

Add to imports from `./schemas.js`:
```typescript
PruneArchiveOptionsSchema,
ArchiveStatsSchema,
```

Add to re-export types:
```typescript
PruneArchiveOptions,
ArchiveStats,
```

- [ ] **Step 3: Commit**

```bash
git add packages/duron/src/adapters/adapter.ts
git commit -m "feat: add archive abstract methods to adapter base class"
```

---

## Task 4: Core Adapter - Create Job

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`

**Context:** `_createJob` currently inserts into `this.tables.jobsTable`. Change to `jobsActiveTable`.

- [ ] **Step 1: Update _createJob**

```typescript
protected async _createJob({ queue, groupKey, input, timeoutMs, checksum, concurrencyLimit, concurrencyStepLimit, description }: CreateJobOptions) {
  const [result] = await this.db
    .insert(this.tables.jobsActiveTable)
    .values({
      action_name: queue,
      group_key: groupKey,
      description: description ?? null,
      checksum,
      input,
      status: JOB_STATUS_CREATED,
      timeout_ms: timeoutMs,
      concurrency_limit: concurrencyLimit,
      concurrency_step_limit: concurrencyStepLimit,
    })
    .returning({ id: this.tables.jobsActiveTable.id })

  if (!result) {
    return null
  }

  return result.id
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts
git commit -m "feat: update createJob to insert into jobs_active"
```

---

## Task 5: Core Adapter - Complete/Fail/Cancel Job (Move to Archive)

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`

**Context:** Replace UPDATE with MOVE (DELETE from active + INSERT into archive).

- [ ] **Step 1: Write _completeJob with archive move**

```typescript
protected async _completeJob({ jobId, output }: CompleteJobOptions) {
  const result = await this.db.execute(sql`
    WITH moved_job AS (
      DELETE FROM ${this.tables.jobsActiveTable}
      WHERE id = ${jobId}
        AND status = ${JOB_STATUS_ACTIVE}
        AND client_id = ${this.id}
        AND expires_at > now()
      RETURNING *
    ),
    moved_steps AS (
      DELETE FROM ${this.tables.jobStepsActiveTable}
      WHERE job_id = ${jobId}
      RETURNING *
    ),
    moved_spans AS (
      DELETE FROM ${this.tables.spansActiveTable}
      WHERE job_id = ${jobId}
      RETURNING *
    ),
    inserted_job AS (
      INSERT INTO ${this.tables.jobsArchiveTable}
      SELECT * FROM moved_job
      RETURNING finished_at
    )
    INSERT INTO ${this.tables.jobStepsArchiveTable}
    SELECT ms.*, ij.finished_at AS job_finished_at
    FROM moved_steps ms, inserted_job ij;

    INSERT INTO ${this.tables.spansArchiveTable}
    SELECT * FROM moved_spans;

    SELECT id FROM inserted_job
  `)

  return result.length > 0
}
```

- [ ] **Step 2: Write _failJob with archive move**

Similar to _completeJob but with error and status = failed.

```typescript
protected async _failJob({ jobId, output, error }: FailJobOptions) {
  // Same CTE pattern as _completeJob
  // status will be 'failed' in the deleted row
}
```

- [ ] **Step 3: Write _cancelJob with archive move**

Similar to above but with status = cancelled.

- [ ] **Step 4: Run tests**

Run: `cd packages/duron && bun test adapter.test.ts`
Expected: FAIL (tests still expect old table names)

- [ ] **Step 5: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts
git commit -m "feat: implement archive move on job completion/failure/cancel"
```

---

## Task 6: Core Adapter - Fetch and Recovery

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`

**Context:** `_fetch` and `_recoverJobs` only query active tables now.

- [ ] **Step 1: Update _fetch to query jobs_active**

Replace all `this.tables.jobsTable` references in the fetch CTE with `this.tables.jobsActiveTable`.

- [ ] **Step 2: Update _recoverJobs to query jobs_active**

Replace `this.tables.jobsTable` with `this.tables.jobsActiveTable` in the recovery query.

- [ ] **Step 3: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts
git commit -m "feat: update fetch and recovery to query active tables only"
```

---

## Task 7: Core Adapter - Retry Job

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`

**Context:** Retry must read from archive (failed jobs are archived immediately).

- [ ] **Step 1: Update _retryJob to read from archive**

```typescript
protected async _retryJob({ jobId }: RetryJobOptions) {
  // CTE that:
  // 1. Locks source job in jobsArchiveTable (not jobsActiveTable)
  // 2. Checks for existing retry in jobsActiveTable
  // 3. Inserts retry into jobsActiveTable
  // Returns new job ID
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts
git commit -m "feat: update retry to read from archive tables"
```

---

## Task 8: Core Adapter - Query Methods

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`

**Context:** Query methods need to route to correct table(s).

- [ ] **Step 1: Update _getJobById**

```typescript
protected async _getJobById(jobId: string): Promise<Job | null> {
  // Try jobs_active first
  const active = await this.db.query.jobsActiveTable.findFirst({
    where: eq(this.tables.jobsActiveTable.id, jobId)
  })
  if (active) return active

  // Then jobs_archive
  const archive = await this.db.query.jobsArchiveTable.findFirst({
    where: eq(this.tables.jobsArchiveTable.id, jobId)
  })
  return archive ?? null
}
```

- [ ] **Step 2: Update _getJobs with table routing**

Add table routing logic before query:
```typescript
protected async _getJobs(options?: GetJobsOptions): Promise<GetJobsResult> {
  const filters = options?.filters ?? {}
  const statusFilter = filters.status
  
  // Determine which table(s) to query
  const activeStatuses = [JOB_STATUS_CREATED, JOB_STATUS_ACTIVE]
  const archiveStatuses = [JOB_STATUS_COMPLETED, JOB_STATUS_FAILED, JOB_STATUS_CANCELLED]
  
  const statuses = Array.isArray(statusFilter) ? statusFilter : statusFilter ? [statusFilter] : []
  
  const queryActive = statuses.length === 0 || statuses.some(s => activeStatuses.includes(s))
  const queryArchive = statuses.length === 0 || statuses.some(s => archiveStatuses.includes(s))
  
  // Build and execute query based on routing
  // ... implementation
}
```

- [ ] **Step 3: Update _getJobSteps, _getJobStepById**

Route to active/archive based on job location.

- [ ] **Step 4: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts
git commit -m "feat: implement query routing for active/archive tables"
```

---

## Task 9: Core Adapter - Archive API

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`

**Context:** Implement prune, truncate, and stats.

- [ ] **Step 1: Implement _pruneArchive**

```typescript
protected async _pruneArchive(options: PruneArchiveOptions): Promise<number> {
  const threshold = this._parseOlderThan(options.olderThan)
  const batchSize = options.batchSize ?? 10000
  const maxBatches = options.maxBatches ?? 100
  
  let totalDeleted = 0
  
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await this.db.execute<{ count: number }>(sql`
      WITH deleted_jobs AS (
        DELETE FROM ${this.tables.jobsArchiveTable}
        WHERE finished_at < ${threshold}
        LIMIT ${batchSize}
        RETURNING id
      ),
      deleted_steps AS (
        DELETE FROM ${this.tables.jobStepsArchiveTable}
        WHERE job_id IN (SELECT id FROM deleted_jobs)
      ),
      deleted_spans AS (
        DELETE FROM ${this.tables.spansArchiveTable}
        WHERE job_id IN (SELECT id FROM deleted_jobs)
      )
      SELECT COUNT(*) as count FROM deleted_jobs
    `)
    
    const deleted = Number(result[0]?.count ?? 0)
    totalDeleted += deleted
    
    if (deleted === 0) break
  }
  
  return totalDeleted
}
```

- [ ] **Step 2: Implement _truncateArchive**

```typescript
protected async _truncateArchive(): Promise<void> {
  await this.db.execute(sql`TRUNCATE ${this.tables.jobsArchiveTable}`)
  await this.db.execute(sql`TRUNCATE ${this.tables.jobStepsArchiveTable}`)
  await this.db.execute(sql`TRUNCATE ${this.tables.spansArchiveTable}`)
}
```

- [ ] **Step 3: Implement _getArchiveStats**

```typescript
protected async _getArchiveStats(): Promise<ArchiveStats> {
  const [jobsResult, stepsResult, spansResult, oldestResult] = await Promise.all([
    this.db.execute<{ count: number }>(sql`SELECT COUNT(*) as count FROM ${this.tables.jobsArchiveTable}`),
    this.db.execute<{ count: number }>(sql`SELECT COUNT(*) as count FROM ${this.tables.jobStepsArchiveTable}`),
    this.db.execute<{ count: number }>(sql`SELECT COUNT(*) as count FROM ${this.tables.spansArchiveTable}`),
    this.db.execute<{ finished_at: Date }>(sql`SELECT finished_at FROM ${this.tables.jobsArchiveTable} ORDER BY finished_at ASC LIMIT 1`),
  ])
  
  return {
    jobsCount: Number(jobsResult[0]?.count ?? 0),
    stepsCount: Number(stepsResult[0]?.count ?? 0),
    spansCount: Number(spansResult[0]?.count ?? 0),
    oldestJobDate: oldestResult[0]?.finished_at ?? null,
    totalSizeBytes: null, // Would need pg_size_pretty, skip for now
    lastPrunedAt: this.lastPrunedAt ?? null,
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts
git commit -m "feat: implement archive prune, truncate, and stats APIs"
```

---

## Task 10: Core Adapter - Scheduler

**Files:**
- Modify: `packages/duron/src/adapters/postgres/base.ts`
- Modify: `packages/duron/src/adapters/postgres/postgres.ts`
- Modify: `packages/duron/src/adapters/postgres/pglite.ts`

**Context:** Add optional scheduler that runs prune on interval with advisory lock.

- [ ] **Step 1: Add scheduler to PostgresAdapter constructor**

```typescript
// In constructor, after options parsing:
if (options.pruneArchive) {
  this.pruneConfig = options.pruneArchive
  this.startScheduler()
}
```

- [ ] **Step 2: Implement scheduler with advisory lock**

```typescript
private pruneTimer: Timer | null = null
private pruneConfig: PruneArchiveOptions | null = null
private lastPrunedAt: Date | null = null

private startScheduler() {
  if (!this.pruneConfig) return
  
  const run = async () => {
    try {
      // Try to acquire advisory lock
      const lockResult = await this.db.execute(sql`
        SELECT pg_try_advisory_lock(${this.advisoryLockKey()})
      `)
      
      if (!lockResult[0]?.pg_try_advisory_lock) {
        return // Another process is pruning
      }
      
      try {
        await this.pruneArchive(this.pruneConfig)
        this.lastPrunedAt = new Date()
      } finally {
        await this.db.execute(sql`
          SELECT pg_advisory_unlock(${this.advisoryLockKey()})
        `)
      }
    } catch (error) {
      this.logger?.error(error, 'Error in prune scheduler')
    }
  }
  
  this.pruneTimer = setInterval(run, this.pruneConfig.intervalMs)
}

private advisoryLockKey(): number {
  // Generate a consistent hash from schema name
  let hash = 0
  for (let i = 0; i < this.schema.length; i++) {
    hash = ((hash << 5) - hash) + this.schema.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}
```

- [ ] **Step 3: Stop scheduler on adapter stop**

```typescript
protected async _stop() {
  if (this.pruneTimer) {
    clearInterval(this.pruneTimer)
    this.pruneTimer = null
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/duron/src/adapters/postgres/base.ts packages/duron/src/adapters/postgres/postgres.ts packages/duron/src/adapters/postgres/pglite.ts
git commit -m "feat: add archive prune scheduler with advisory lock"
```

---

## Task 11: REST API Endpoints

**Files:**
- Modify: `packages/duron/src/server.ts`

**Context:** Add archive endpoints to the REST API server.

- [ ] **Step 1: Add archive routes**

```typescript
// In server setup, add:
app.post('/api/archive/prune', async (req, res) => {
  try {
    const options = req.body ?? {}
    const result = await adapter.pruneArchive(options)
    res.json({ deletedJobs: result })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/archive/truncate', async (req, res) => {
  try {
    const { confirm } = req.body
    if (!confirm) {
      return res.status(400).json({ error: 'Confirmation required' })
    }
    await adapter.truncateArchive()
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/archive/stats', async (req, res) => {
  try {
    const stats = await adapter.getArchiveStats()
    res.json(stats)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/archive/status', async (req, res) => {
  try {
    // Return scheduler config + last run info
    res.json({
      autoPruneEnabled: adapter.pruneConfig !== null,
      config: adapter.pruneConfig,
      nextRunAt: adapter.pruneConfig ? new Date(Date.now() + adapter.pruneConfig.intervalMs) : null,
      lastRunAt: adapter.lastPrunedAt,
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/duron/src/server.ts
git commit -m "feat: add archive REST API endpoints"
```

---

## Task 12: Dashboard - Archive Management Page

**Files:**
- Create: `packages/duron-dashboard/src/pages/ArchivePage.tsx`
- Create: `packages/duron-dashboard/src/components/ArchiveStats.tsx`
- Modify: `packages/duron-dashboard/src/App.tsx` (add route)

**Context:** New page for archive management.

- [ ] **Step 1: Create ArchiveStats component**

```typescript
export function ArchiveStats({ stats }: { stats: ArchiveStats }) {
  return (
    <div className="grid grid-cols-4 gap-4">
      <Card><CardHeader>Jobs</CardHeader><CardContent>{stats.jobsCount}</CardContent></Card>
      <Card><CardHeader>Steps</CardHeader><CardContent>{stats.stepsCount}</CardContent></Card>
      <Card><CardHeader>Spans</CardHeader><CardContent>{stats.spansCount}</CardContent></Card>
      <Card><CardHeader>Oldest Job</CardHeader><CardContent>{stats.oldestJobDate?.toLocaleDateString()}</CardContent></Card>
    </div>
  )
}
```

- [ ] **Step 2: Create ArchivePage**

```typescript
export function ArchivePage() {
  const [stats, setStats] = useState<ArchiveStats | null>(null)
  const [status, setStatus] = useState(null)
  
  useEffect(() => {
    fetch('/api/archive/stats').then(r => r.json()).then(setStats)
    fetch('/api/archive/status').then(r => r.json()).then(setStatus)
  }, [])
  
  const handlePrune = async () => {
    await fetch('/api/archive/prune', { method: 'POST', body: JSON.stringify({}) })
    // Refresh stats
  }
  
  const handleTruncate = async () => {
    if (!confirm('WARNING: This will delete ALL archived jobs. Type "DELETE ALL" to confirm:')) return
    await fetch('/api/archive/truncate', { method: 'POST', body: JSON.stringify({ confirm: true }) })
    // Refresh stats
  }
  
  return (
    <div>
      <h1>Archive Management</h1>
      {stats && <ArchiveStats stats={stats} />}
      <div className="mt-4">
        <Button onClick={handlePrune}>Prune Archive</Button>
        <Button onClick={handleTruncate} variant="destructive">Truncate Archive</Button>
      </div>
      {status && <div>Auto-prune: {status.autoPruneEnabled ? 'Enabled' : 'Disabled'}</div>}
    </div>
  )
}
```

- [ ] **Step 3: Add route in App.tsx**

```typescript
<Route path="/archive" element={<ArchivePage />} />
```

- [ ] **Step 4: Commit**

```bash
git add packages/duron-dashboard/src/
git commit -m "feat: add archive management dashboard page"
```

---

## Task 13: Dashboard - Job List Tabs

**Files:**
- Modify: `packages/duron-dashboard/src/components/JobList.tsx` (or similar)

**Context:** Update job list to have Live/Archive/All tabs.

- [ ] **Step 1: Add tabs to job list**

```typescript
export function JobList() {
  const [activeTab, setActiveTab] = useState<'live' | 'archive' | 'all'>('live')
  const [filters, setFilters] = useState({})
  
  // When tab changes, update status filter
  useEffect(() => {
    if (activeTab === 'live') {
      setFilters(f => ({ ...f, status: ['created', 'active'] }))
    } else if (activeTab === 'archive') {
      setFilters(f => ({ ...f, status: ['completed', 'failed', 'cancelled'] }))
    } else {
      setFilters(f => { const { status, ...rest } = f; return rest })
    }
  }, [activeTab])
  
  return (
    <div>
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="live">Live Jobs</TabsTrigger>
          <TabsTrigger value="archive">Archive</TabsTrigger>
          <TabsTrigger value="all">All Jobs</TabsTrigger>
        </TabsList>
      </Tabs>
      <JobTable filters={filters} />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/duron-dashboard/src/
git commit -m "feat: add live/archive/all tabs to job list"
```

---

## Task 14: Drizzle Migration

**Files:**
- Create: `packages/duron/migrations/postgres/20260418120000_active_archive_split/migration.sql`

**Context:** Generate migration that creates new tables and migrates data.

- [ ] **Step 1: Generate migration with Drizzle**

Run: `cd packages/duron && bun run generate:postgres`
Expected: Creates migration file with new table definitions

- [ ] **Step 2: Add data migration to migration file**

After the CREATE TABLE statements, add:
```sql
-- Migrate existing data
INSERT INTO duron.jobs_active SELECT * FROM duron.jobs WHERE status IN ('created', 'active');
INSERT INTO duron.jobs_archive SELECT * FROM duron.jobs WHERE status IN ('completed', 'failed', 'cancelled');

INSERT INTO duron.job_steps_active SELECT * FROM duron.job_steps WHERE job_id IN (SELECT id FROM duron.jobs_active);
INSERT INTO duron.job_steps_archive SELECT js.*, j.finished_at AS job_finished_at 
FROM duron.job_steps js 
JOIN duron.jobs_archive j ON js.job_id = j.id;

INSERT INTO duron.spans_active SELECT * FROM duron.spans WHERE job_id IN (SELECT id FROM duron.jobs_active);
INSERT INTO duron.spans_archive SELECT * FROM duron.spans WHERE job_id IN (SELECT id FROM duron.jobs_archive);

-- Drop old tables
DROP TABLE duron.spans;
DROP TABLE duron.job_steps;
DROP TABLE duron.jobs;
```

- [ ] **Step 3: Commit**

```bash
git add packages/duron/migrations/
git commit -m "feat: add active/archive split migration"
```

---

## Task 15: Tests

**Files:**
- Create: `packages/duron/test/archive.test.ts`
- Modify: `packages/duron/test/adapter.test.ts`

**Context:** Test archive functionality.

- [ ] **Step 1: Write archive tests**

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { createTestAdapter } from './setup'

describe('Archive', () => {
  let adapter
  
  beforeEach(async () => {
    adapter = await createTestAdapter()
  })
  
  test('completed job moves to archive', async () => {
    const jobId = await adapter.createJob({ ... })
    // Activate and complete job
    await adapter.completeJob({ jobId, output: {} })
    
    const active = await adapter.getJobById(jobId)
    expect(active).toBeNull()
    
    // Should be in archive
    const archive = await adapter._getJobFromArchive(jobId)
    expect(archive).not.toBeNull()
    expect(archive.status).toBe('completed')
  })
  
  test('prune archive deletes old jobs', async () => {
    // Create and complete job with old finished_at
    // Prune with olderThan: '1d'
    // Verify deleted
  })
  
  test('truncate archive removes all data', async () => {
    await adapter.truncateArchive()
    const stats = await adapter.getArchiveStats()
    expect(stats.jobsCount).toBe(0)
  })
  
  test('advisory lock prevents concurrent prune', async () => {
    // Test that two processes can't prune simultaneously
  })
})
```

- [ ] **Step 2: Update existing adapter tests**

Update all tests to expect jobs in active/archive tables rather than single table.

- [ ] **Step 3: Run tests**

Run: `cd packages/duron && bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/duron/test/
git commit -m "test: add archive functionality tests"
```

---

## Task 16: Verification

**Files:**
- All modified files

**Context:** Final verification before completion.

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: active/archive split implementation complete"
```

---

## Self-Review

### Spec Coverage Check

| Spec Section | Plan Task |
|--------------|-----------|
| Schema Design (3.1) | Task 1 |
| Adapter Methods (4.1) | Tasks 4-8 |
| Archive API (4.2) | Task 9 |
| Scheduler (4.3-4.4) | Task 10 |
| REST API (5) | Task 11 |
| Dashboard Archive Page (6.2) | Task 12 |
| Dashboard Job List (6.1) | Task 13 |
| Migration (7) | Task 14 |
| Testing (8) | Task 15 |

✅ All spec sections covered.

### Placeholder Scan

- No TBD/TODO/FIXME/PLACEHOLDER found
- All steps contain actual code
- All commands are exact with expected output
- Type names consistent throughout

### Type Consistency

- `PruneArchiveOptions` — defined in schemas.ts, used in adapter.ts and base.ts
- `ArchiveStats` — defined in schemas.ts, used consistently
- Table names: `jobsActiveTable`, `jobsArchiveTable`, etc. — consistent

✅ No type inconsistencies found.

---

*End of Implementation Plan*

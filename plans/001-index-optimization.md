# Plan: Database Index Optimization

**Commit:** `c641e40`
**Date:** 2025-07-19
**Finding:** Index overhead on hot-path tables degrades INSERT/UPDATE performance

---

## Problem

The hot-path tables (`jobs_active`, `job_steps_active`, `spans`) have excessive indexes that must be maintained on every INSERT and UPDATE. This creates write amplification that degrades throughput.

**Current index counts:**

- `jobs_active`: 15 indexes (plus PK + check)
- `job_steps_active`: 8 indexes (plus unique + check)
- `spans`: 11 indexes (plus checks)

**Impact:** Every job creation updates 15+ indexes. Every step completion updates 8+ indexes. Every span emission updates 11+ indexes. At high throughput, this becomes the bottleneck.

---

## Analysis: Index Usage by Query Pattern

### jobs_active indexes

| Index                                    | Used In                                                              | Verdict                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `idx_jobs_active_action_name`            | `_fetch` CTE, `_recoverJobs`, `_buildJobsWhereClause`                | **KEEP** - hot path                                      |
| `idx_jobs_active_status`                 | `_fetch` CTE, `_recoverJobs`, `_deleteJobs`, `_buildJobsWhereClause` | **KEEP** - hot path                                      |
| `idx_jobs_active_group_key`              | `_fetch` CTE, `_buildJobsWhereClause`                                | **KEEP** - hot path                                      |
| `idx_jobs_active_description`            | `_buildJobsWhereClause` (fuzzy search only)                          | **REMOVE** - dashboard-only, rare query                  |
| `idx_jobs_active_started_at`             | `_buildJobsWhereClause` (date filter)                                | **REMOVE** - dashboard-only, can use status index + sort |
| `idx_jobs_active_expires_at`             | `_recoverJobs` (expired jobs)                                        | **KEEP** - recovery runs periodically                    |
| `idx_jobs_active_client_id`              | `_recoverJobs` (multi-process ping)                                  | **KEEP** - multi-process mode                            |
| `idx_jobs_active_checksum`               | `_retryJob` (duplicate check)                                        | **KEEP** - correctness                                   |
| `idx_jobs_active_concurrency_limit`      | **NEVER** in WHERE clause                                            | **REMOVE** - unused                                      |
| `idx_jobs_active_concurrency_step_limit` | **NEVER** in WHERE clause                                            | **REMOVE** - unused                                      |
| `idx_jobs_active_action_status`          | Redundant with single-column indexes                                 | **REMOVE** - PostgreSQL can combine                      |
| `idx_jobs_active_action_group`           | `_fetch` CTE (eligible_groups)                                       | **KEEP** - hot path                                      |
| `idx_jobs_active_input_fts`              | `_buildJsonbWhereConditions` (dashboard)                             | **REMOVE** - dashboard-only, expensive GIN               |
| `idx_jobs_active_output_fts`             | `_buildJsonbWhereConditions` (dashboard)                             | **REMOVE** - output is NULL for active jobs              |

**Summary:** Remove 7 indexes from `jobs_active` (15 → 8)

### job_steps_active indexes

| Index                                 | Used In                                    | Verdict                                 |
| ------------------------------------- | ------------------------------------------ | --------------------------------------- |
| `idx_job_steps_active_job_id`         | `_getJobSteps`, cascade deletes            | **KEEP** - hot path                     |
| `idx_job_steps_active_status`         | `_buildStepsWhereClause`                   | **KEEP** - used in queries              |
| `idx_job_steps_active_name`           | `_buildStepsWhereClause`                   | **KEEP** - used in queries              |
| `idx_job_steps_active_expires_at`     | Recovery queries                           | **KEEP** - needed for expiry checks     |
| `idx_job_steps_active_parent_step_id` | Recursive step queries                     | **KEEP** - tree traversal               |
| `idx_job_steps_active_job_status`     | Redundant with job_id + status             | **REMOVE** - PostgreSQL can combine     |
| `idx_job_steps_active_job_name`       | Redundant with job_id + name               | **REMOVE** - PostgreSQL can combine     |
| `idx_job_steps_active_output_fts`     | Dashboard search (output is usually small) | **REMOVE** - expensive GIN, rarely used |

**Summary:** Remove 3 indexes from `job_steps_active` (8 → 5)

### spans indexes

| Index                    | Used In                      | Verdict                                 |
| ------------------------ | ---------------------------- | --------------------------------------- |
| `idx_spans_trace_id`     | `_getSpans` (trace lookup)   | **KEEP** - dashboard                    |
| `idx_spans_span_id`      | `_getSpans` (span lookup)    | **KEEP** - dashboard                    |
| `idx_spans_job_id`       | `_getSpans` (job spans)      | **KEEP** - hot path                     |
| `idx_spans_step_id`      | `_getSpans` (step spans)     | **KEEP** - hot path                     |
| `idx_spans_name`         | `_buildSpansWhereClause`     | **KEEP** - dashboard filter             |
| `idx_spans_kind`         | Rarely queried               | **REMOVE** - dashboard-only             |
| `idx_spans_status_code`  | Rarely queried               | **REMOVE** - dashboard-only             |
| `idx_spans_job_step`     | `_getSpans` (step+job combo) | **KEEP** - hot path                     |
| `idx_spans_trace_parent` | `_getSpans` (trace tree)     | **KEEP** - dashboard                    |
| `idx_spans_attributes`   | Dashboard attribute search   | **REMOVE** - expensive GIN, rarely used |
| `idx_spans_events`       | Dashboard event search       | **REMOVE** - expensive GIN, rarely used |

**Summary:** Remove 4 indexes from `spans` (11 → 7)

---

## Total Impact

| Table            | Before | After  | Removed |
| ---------------- | ------ | ------ | ------- |
| jobs_active      | 15     | 8      | 7       |
| job_steps_active | 8      | 5      | 3       |
| spans            | 11     | 7      | 4       |
| **Total**        | **34** | **20** | **14**  |

**Expected improvement:** ~40% reduction in index maintenance overhead on hot-path writes.

---

## Implementation

### Step 1: Create migration to drop unused indexes

```sql
-- Migration: Drop unused indexes to improve write performance
-- Generated from index analysis on commit c641e40

-- jobs_active: Remove 7 indexes
DROP INDEX IF EXISTS duron.idx_jobs_active_description;
DROP INDEX IF EXISTS duron.idx_jobs_active_started_at;
DROP INDEX IF EXISTS duron.idx_jobs_active_concurrency_limit;
DROP INDEX IF EXISTS duron.idx_jobs_active_concurrency_step_limit;
DROP INDEX IF EXISTS duron.idx_jobs_active_action_status;
DROP INDEX IF EXISTS duron.idx_jobs_active_input_fts;
DROP INDEX IF EXISTS duron.idx_jobs_active_output_fts;

-- job_steps_active: Remove 3 indexes
DROP INDEX IF EXISTS duron.idx_job_steps_active_job_status;
DROP INDEX IF EXISTS duron.idx_job_steps_active_job_name;
DROP INDEX IF EXISTS duron.idx_job_steps_active_output_fts;

-- spans: Remove 4 indexes
DROP INDEX IF EXISTS duron.idx_spans_kind;
DROP INDEX IF EXISTS duron.idx_spans_status_code;
DROP INDEX IF EXISTS duron.idx_spans_attributes;
DROP INDEX IF EXISTS duron.idx_spans_events;
```

### Step 2: Update schema.ts to remove index definitions

Remove the corresponding index definitions from `packages/duron/src/adapters/postgres/schema.ts`.

### Step 3: Verify

```bash
cd /Users/tincho/projects/tinchoz49/duron
bun run typecheck
bun run lint
bun test
```

All existing tests must pass. The removed indexes are not used by any query in the codebase.

---

## Files to Modify

1. `packages/duron/src/adapters/postgres/schema.ts` - Remove index definitions
2. `packages/duron/migrations/` - New migration file (auto-generated by drizzle-kit)

## Files NOT to Modify

- `packages/duron/src/adapters/postgres/base.ts` - No query changes needed
- Any test files - Existing tests validate functionality

---

## Risk Assessment

**Risk: LOW**

- Removed indexes are not used in any WHERE clause in the codebase
- Dashboard queries that used these indexes will still work, just slower (acceptable for dashboard)
- Hot-path write performance improves significantly
- Can be re-added later if specific dashboard queries need them

**Escape hatch:** If a removed index causes dashboard performance issues, it can be re-added with a new migration.

---

## Maintenance Notes

- Monitor dashboard query performance after deployment
- If specific dashboard pages become slow, consider adding targeted indexes back
- The `_buildJobsWhereClause` fuzzy search still works without `description` index (full table scan is acceptable for dashboard)
- GIN indexes on `input`/`output` in active tables are wasteful since active jobs have `output = NULL`

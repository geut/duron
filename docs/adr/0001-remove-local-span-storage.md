# ADR 0001: Remove Local OpenTelemetry Span Storage

## Status

Accepted

## Date

2026-07-21

## Context

Duron previously offered a `telemetry: { local: true }` option that stored OpenTelemetry spans in a PostgreSQL `spans` table, queried them via REST API (`/jobs/:id/spans`, `/steps/:id/spans`), and displayed them in the dashboard via a `SpansPanel` component. This created significant complexity:

- A dedicated `spans` table with 6 indexes and 2 check constraints
- A `LocalSpanExporter` class that converted OTel spans to SQL inserts
- Recursive CTE queries for step-span hierarchies
- Orphan span cleanup logic in `_deleteJobs` and `_truncateArchive`
- Dashboard components for rendering span timelines
- 4 additional `@opentelemetry/*` runtime dependencies

Meanwhile, the OpenTelemetry ecosystem already provides production-grade span storage and visualization (Jaeger, Grafana Tempo, Honeycomb, etc.). The local storage duplicated this functionality without the flexibility of those tools.

## Decision

Remove `telemetry.local` entirely. Keep the OTel instrumentation (`@opentelemetry/api` context propagation, span creation in `step-manager.ts` and `action-job.ts`) and the `telemetry.traceExporter` path for sending spans to external OTel collectors.

### What stays

- `@opentelemetry/api` as a regular dependency
- `ctx.telemetry.span / tracer / track() / flush()` in action contexts
- Context propagation and automatic span creation
- `telemetry: { traceExporter: exporter }` configuration
- `traceExporter` now accepts `SpanExporter | SpanExporter[]`

### What is removed

- `telemetry.local` option and `LocalTelemetryOptions` type
- `spans` table from the schema
- `LocalSpanExporter` class
- `/jobs/:id/spans` and `/steps/:id/spans` REST endpoints
- `getJobSpans()` and `getStepSpans()` client methods
- `client.spansEnabled` getter
- Dashboard `SpansPanel`, `SpansContext`, `useJobSpans`/`useStepSpans`
- Orphan span cleanup queries
- `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-node`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` as direct dependencies

### New optional peer dependencies

Users who want external OTel export install these themselves:

- `@opentelemetry/sdk-trace-base`
- `@opentelemetry/sdk-node`

### Error handling

If `traceExporter` is provided but `@opentelemetry/sdk-node` is not installed, Duron throws at startup with a clear message.

## Consequences

- **Positive**: Simpler codebase, fewer dependencies, no orphan span cleanup logic, no span queries
- **Positive**: Users get production-grade observability by connecting to existing OTel infrastructure
- **Positive**: Dashboard is leaner (3 fewer components, 1 fewer context, 2 fewer hooks)
- **Negative**: Users who relied on `local: true` must migrate to an external collector
- **Negative**: No built-in span viewing in the dashboard — users must open Jaeger/Grafana separately

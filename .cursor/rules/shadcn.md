---
description: Use Shadcn UI components instead of custom components.
globs: "*.tsx"
alwaysApply: false
---

> **See `CLAUDE.md` for full project context and documentation.**

Do not touch any files in the `packages/duron-dashboard/src/components/ui` directory.
These files are managed by Shadcn UI and should not be modified.

When working on the dashboard:
- Use existing UI components from `src/components/ui/`
- Follow established patterns in `src/views/` and `src/components/`
- Use TanStack Query for data fetching
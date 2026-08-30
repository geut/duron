---
name: release
description: "Analyze recent changes, suggest a release version, and publish duron / duron-dashboard. Use when the user says 'release', 'publish', 'bump version', or 'cut a release'."
---

# Release

Analyze what changed since the last release, suggest a bump type, then run `scripts/release.ts` with the user's approval.

## Step 1: Analyze changes

Find the last release tags and commits since:

```bash
# Check for existing tags
git tag --list 'duron@*' --sort=-version:refname | head -1
git tag --list 'duron-dashboard@*' --sort=-version:refname | head -1
```

**If tags exist:** use the most recent tag as the reference point.

```bash
git log <last-tag>..HEAD --oneline
git diff <last-tag>..HEAD --stat
```

**If no tags exist:** find the last release-related commit:

```bash
# Look for commits with "release" in the message
git log --oneline --all --grep="release" | head -5

# Or find when the current version was set
git log --oneline -S '"version": "0.3.0' -- packages/duron/package.json | head -1
```

Use that commit as the reference point. If nothing useful is found, use the first commit and note that this is the initial release.

Get the current versions:

```bash
grep '"version"' packages/duron/package.json packages/duron-dashboard/package.json
```

## Step 2: Suggest

Read the commit messages carefully. Look for:

- `feat:` → new features → **minor** bump (or preminor/prepatch if beta)
- `fix:` → bug fixes → **patch** bump (or prerelease if beta)
- `perf:` → performance → **patch** bump
- `refactor:` → internal cleanup → **patch** bump (no user-facing change)
- `BREAKING CHANGE` or `!` after scope → **major** bump
- `docs:`, `chore:`, `test:`, `ci:` → no release needed (unless combined with releasable changes)

Check if the current version is a beta/prerelease (contains `-beta` or `-alpha`).

Present a clear recommendation:

```
Current versions:
  duron:           x.y.z-beta.N
  duron-dashboard: x.y.z-beta.N

Changes since last release:
  - feat: ...
  - fix: ...

Suggested release: <bump type>
  duron:           x.y.z → a.b.c
  duron-dashboard: x.y.z → a.b.c

Reasoning: <why this bump type>
```

Bump rules:

- If current is beta and changes are fixes → `prerelease` (increment beta number)
- If current is beta and changes include features → `preminor` or `prepatch` (new beta minor)
- If current is stable and changes are fixes → `patch`
- If current is stable and changes include features → `minor`
- If there's a breaking change → `major` (or `premajor` if going to beta)

**Wait for user approval before proceeding.** The user may:

- Approve the suggestion
- Ask for a different bump type
- Ask to release only one package (`--package duron`)
- Ask to skip the release

## Step 3: Run the release

When approved, run the release script. **npm publish requires OTP (one-time password).**

### If Herdr is available (HERDR_ENV=1)

Split a pane to the right and run the release there. This lets the user type the OTP in the new pane without interrupting the conversation.

```bash
# Verify Herdr is available
test "${HERDR_ENV:-}" = "1" || echo "Herdr not available"
```

Split a new pane (preserve cwd, keep focus on current pane):

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Parse the pane ID from the JSON response — it's at `.result.pane.pane_id`. Then run the release in that pane:

```bash
herdr pane run <pane-id> "cd /Users/tincho/projects/tinchoz49/duron && bun run release <bump-args>"
```

Wait for the OTP prompt to appear in the pane output:

```bash
herdr pane wait-output <pane-id> --regex "[Oo][Tt][Pp]|one.time" --timeout 120000
```

When the prompt appears, tell the user:

> The release is running in a separate pane on the right. Enter your npm OTP there when prompted.

**Do NOT attempt to enter the OTP automatically.** The user must type it manually in the Herdr pane.

### If Herdr is not available

Run the release directly. When npm prompts for OTP, ask the user:

> npm is asking for a one-time password. Please provide your OTP (from your authenticator app).

## Step 4: Verify

After the release completes, verify what was published:

```bash
# Check tags were created
git tag --list 'duron@*' --sort=-version:refname | head -1
git tag --list 'duron-dashboard@*' --sort=-version:refname | head -1
```

Try to verify npm (may fail if not yet synced):

```bash
npm view duron version 2>/dev/null || echo "not yet on npm"
npm view duron-dashboard version 2>/dev/null || echo "not yet on npm"
```

Report the result:

- ✅ Published versions
- ✅ Git tags created
- ✅ GitHub releases created (link to each)
- If not pushed yet: remind to run `git push && git push --tags`

## Release notes

GitHub release notes are generated automatically:

1. **Changelog** — all commits between the previous tag and the new tag are listed as bullet points
2. **Notes** — if `--notes <text>` is provided, appended under a `### Notes` section

Use `--notes` when the commit messages alone don't tell the full story. Good notes explain **why** the change matters, not just **what** changed.

```bash
# Example: simple release (changelog only)
bun run release prerelease --otp 123456

# Example: with additional context
bun run release prerelease --notes "Switched from zod to zod/mini for 60% smaller bundle" --otp 123456
```

## Flags reference

| Flag               | Effect                                      |
| ------------------ | ------------------------------------------- |
| `--dry-run`        | Preview without changes                     |
| `--package <name>` | Release only one package                    |
| `--no-tag`         | Skip git commit + tag                       |
| `--no-publish`     | Skip npm publish                            |
| `--no-build`       | Skip build step                             |
| `--no-release`     | Skip GitHub release                         |
| `--notes <text>`   | Additional notes (appended after changelog) |

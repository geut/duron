---
name: release
description: "Analyze recent changes, suggest a release version, and publish duron / duron-dashboard. Use when the user says 'release', 'publish', 'bump version', or 'cut a release'."
---

# Release

Analyze what changed since the last release, suggest a bump type, then run `scripts/release.ts` with the user's approval.

## Step 1: Analyze changes

Find the last release tags and the commits since:

```bash
git tag --list 'duron@*' --sort=-version:refname | head -1
git tag --list 'duron-dashboard@*' --sort=-version:refname | head -1
git log <last-tag>..HEAD --oneline
git diff <last-tag>..HEAD --stat
```

If no tags exist yet, use the first commit or the branch point.

Read the commit messages carefully. Look for:

- `feat:` → new features → **minor** bump (or preminor/prepatch if beta)
- `fix:` → bug fixes → **patch** bump (or prerelease if beta)
- `perf:` → performance → **patch** bump
- `refactor:` → internal cleanup → **patch** bump (no user-facing change)
- `BREAKING CHANGE` or `!` after scope → **major** bump
- `docs:`, `chore:`, `test:`, `ci:` → no release needed (unless combined with releasable changes)

Check if the current version is a beta/prerelease (contains `-beta` or `-alpha`):

```bash
grep '"version"' packages/duron/package.json
```

## Step 2: Suggest

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

Split a pane to the right and run the release there so the user can enter the OTP when prompted:

```bash
# Check Herdr is available
test "${HERDR_ENV:-}" = "1"

# Split a new pane to the right
herdr pane split --current --direction right --cwd "$PWD" --no-focus

# Run the release in the new pane (capture pane ID from split output)
herdr pane run <pane-id> "bun run release <bump-args>"

# Wait for the OTP prompt — look for "npm" and "otp" or "One-time" in output
herdr pane wait-output <pane-id> --regex "otp|One-time|OTP" --timeout 60000

# Tell the user to enter the OTP in the new pane
```

When the OTP prompt appears, tell the user:
> The release is running in a separate pane. Enter your npm OTP there when prompted.

Do NOT attempt to enter the OTP automatically. The user must type it manually.

### If Herdr is not available

Run the release directly and ask the user for the OTP when npm prompts for it:

```bash
bun run release <bump-args>
```

When the OTP prompt appears, ask the user:
> npm is asking for a one-time password. Please provide your OTP (from your authenticator app).

## Step 4: Verify

After the release completes:

```bash
# Check the new tags were created
git tag --list 'duron@*' --sort=-version:refname | head -1
git tag --list 'duron-dashboard@*' --sort=-version:refname | head -1

# Verify npm published
npm view duron version
npm view duron-dashboard version
```

Report the result:
- ✅ Published versions
- ✅ Git tags created
- ✅ GitHub releases created (link to each)
- Remind to push if not already: `git push && git push --tags`

## Flags reference

The release script supports:

| Flag | Effect |
|------|--------|
| `--dry-run` | Preview without changes |
| `--package <name>` | Release only one package |
| `--no-tag` | Skip git commit + tag |
| `--no-publish` | Skip npm publish |
| `--no-build` | Skip build step |
| `--no-release` | Skip GitHub release |
| `--pr <number>` | Use specific PR for release notes |
| `--notes <text>` | Custom release notes |

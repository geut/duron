#!/usr/bin/env bun
/**
 * Release script for duron and duron-dashboard.
 *
 * Usage:
 *   bun run scripts/release.ts <bump> [--dry-run]
 *
 * Bump types:
 *   patch          0.3.0-beta.18 → 0.3.0-beta.19
 *   minor          0.3.0-beta.18 → 0.4.0-beta.0
 *   major          0.3.0-beta.18 → 1.0.0-beta.0
 *   prepatch       0.3.0-beta.18 → 0.3.1-beta.0
 *   preminor       0.3.0-beta.18 → 0.4.0-beta.0
 *   premajor       0.3.0-beta.18 → 1.0.0-beta.0
 *   prerelease     0.3.0-beta.18 → 0.3.0-beta.19
 *   1.2.3          explicit version
 *
 * Flags:
 *   --dry-run      Show what would happen without writing
 *   --package      Release only one package: duron | duron-dashboard
 *   --no-tag       Skip git tag creation
 *   --no-publish   Skip npm publish (still bumps + tags)
 *   --no-build     Skip build step before publish
 */

import { parseArgs } from "util"
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { $ } from "bun"

const ROOT = join(import.meta.dir, "..")
const PACKAGES = ["duron", "duron-dashboard"] as const

type Package = (typeof PACKAGES)[number]

interface PackageConfig {
  name: Package
  path: string
  tag: string // npm dist-tag
}

const PACKAGE_CONFIG: Record<Package, PackageConfig> = {
  duron: {
    name: "duron",
    path: join(ROOT, "packages/duron/package.json"),
    tag: "latest",
  },
  "duron-dashboard": {
    name: "duron-dashboard",
    path: join(ROOT, "packages/duron-dashboard/package.json"),
    tag: "latest",
  },
}

// --- Version math (no external deps) ---

function parseSemver(v: string) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!m) throw new Error(`Invalid semver: ${v}`)
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    prerelease: m[4] ?? null,
  }
}

function formatSemver(s: ReturnType<typeof parseSemver>) {
  return `${s.major}.${s.minor}.${s.patch}${s.prerelease ? `-${s.prerelease}` : ""}`
}

function bumpVersion(current: string, bump: string): string {
  const s = parseSemver(current)

  // Explicit version
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump

  const isPrerelease = s.prerelease !== null

  switch (bump) {
    case "prerelease":
      if (!isPrerelease) return `${s.major}.${s.minor}.${s.patch}-beta.0`
      // Increment the numeric part after the last dot in the prerelease tag
      const parts = s.prerelease.split(".")
      const last = +parts[parts.length - 1]
      parts[parts.length - 1] = String(last + 1)
      return `${s.major}.${s.minor}.${s.patch}-${parts.join(".")}`
    case "patch":
      return isPrerelease
        ? `${s.major}.${s.minor}.${s.patch}`
        : `${s.major}.${s.minor}.${s.patch + 1}`
    case "minor":
      return isPrerelease
        ? `${s.major}.${s.minor + 1}.0`
        : `${s.major}.${s.minor + 1}.0`
    case "major":
      return isPrerelease
        ? `${s.major + 1}.0.0`
        : `${s.major + 1}.0.0`
    case "prepatch":
      return `${s.major}.${s.minor}.${s.patch + 1}-beta.0`
    case "preminor":
      return `${s.major}.${s.minor + 1}.0-beta.0`
    case "premajor":
      return `${s.major + 1}.0.0-beta.0`
    default:
      throw new Error(`Unknown bump type: ${bump}`)
  }
}

// --- Main ---

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    package: { type: "string" },
    "no-tag": { type: "boolean", default: false },
    "no-publish": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
})

if (values.help || positionals.length === 0) {
  console.log(`
Usage: bun run scripts/release.ts <bump> [options]

Bump:  patch | minor | major | prepatch | preminor | premajor | prerelease | x.y.z

Options:
  --dry-run          Preview changes without writing
  --package <name>   Release only duron or duron-dashboard
  --no-tag           Skip git tag
  --no-publish       Skip npm publish
  --no-build         Skip build step
  --help             Show this message
`)
  process.exit(0)
}

const bump = positionals[0]
const dryRun = values["dry-run"]
const onlyPackage = values.package as Package | undefined
const createTag = !values["no-tag"]
const doPublish = !values["no-publish"]
const doBuild = !values["no-build"]

if (onlyPackage && !PACKAGES.includes(onlyPackage)) {
  console.error(`Unknown package: ${onlyPackage}. Use: ${PACKAGES.join(" | ")}`)
  process.exit(1)
}

const targets = onlyPackage ? [PACKAGE_CONFIG[onlyPackage]] : PACKAGES.map((p) => PACKAGE_CONFIG[p])

console.log(`\n📦 Release plan (${dryRun ? "DRY RUN" : "LIVE"})\n`)

interface ReleasePlan {
  config: PackageConfig
  current: string
  next: string
}

const plan: ReleasePlan[] = []

for (const config of targets) {
  const pkg = JSON.parse(readFileSync(config.path, "utf-8"))
  const current: string = pkg.version
  const next = bumpVersion(current, bump)
  plan.push({ config, current, next })

  const arrow = current === next ? "(no change)" : `→ ${next}`
  console.log(`  ${config.name}: ${current} ${arrow}`)
}

console.log()

if (dryRun) {
  console.log("Dry run — no changes made.\n")
  process.exit(0)
}

// --- Bump versions ---

for (const { config, next } of plan) {
  const pkg = JSON.parse(readFileSync(config.path, "utf-8"))
  pkg.version = next
  writeFileSync(config.path, JSON.stringify(pkg, null, 2) + "\n")
  console.log(`✅ Bumped ${config.name} to ${next}`)
}

// --- Build ---

if (doBuild) {
  console.log("\n🔨 Building...")
  for (const { config } of plan) {
    try {
      await $`cd ${join(ROOT, "packages", config.name)} && bun run build`.quiet()
      console.log(`  ✅ ${config.name} built`)
    } catch (e) {
      console.error(`  ❌ ${config.name} build failed`)
      process.exit(1)
    }
  }
}

// --- Publish ---

if (doPublish) {
  console.log("\n🚀 Publishing...")
  for (const { config, next } of plan) {
    try {
      const tag = next.includes("beta") || next.includes("alpha") ? "next" : config.tag
      await $`cd ${join(ROOT, "packages", config.name)} && npm publish --tag ${tag}`.quiet()
      console.log(`  ✅ ${config.name}@${next} published (${tag})`)
    } catch (e) {
      console.error(`  ❌ ${config.name} publish failed`)
      process.exit(1)
    }
  }
}

// --- Git commit + tag ---

if (createTag) {
  console.log("\n🏷️  Tagging...")
  for (const { config, next } of plan) {
    const tagName = `${config.name}@${next}`
    await $`git add ${config.path}`
    await $`git commit -m "release: ${tagName}"`
    await $`git tag ${tagName}`
    console.log(`  ✅ ${tagName}`)
  }
  console.log("\n  Run `git push && git push --tags` when ready.\n")
}

console.log("\n🎉 Done!\n")

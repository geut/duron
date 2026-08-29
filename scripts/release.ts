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
 *   --dry-run       Show what would happen without writing
 *   --package       Release only one package: duron | duron-dashboard
 *   --no-tag        Skip git tag creation
 *   --no-publish    Skip npm publish (still bumps + tags)
 *   --no-build      Skip build step before publish
 *   --no-release    Skip GitHub release creation
 *   --pr <number>   Use specific PR as release notes (default: latest merged)
 *   --notes <text>  Custom release notes (instead of PR description)
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'

import { $ } from 'bun'

const ROOT = join(import.meta.dir, '..')
const PACKAGES = ['duron', 'duron-dashboard'] as const

type Package = (typeof PACKAGES)[number]

interface PackageConfig {
  name: Package
  path: string
  npmTag: string
}

const PACKAGE_CONFIG: Record<Package, PackageConfig> = {
  duron: {
    name: 'duron',
    path: join(ROOT, 'packages/duron/package.json'),
    npmTag: 'latest',
  },
  'duron-dashboard': {
    name: 'duron-dashboard',
    path: join(ROOT, 'packages/duron-dashboard/package.json'),
    npmTag: 'latest',
  },
}

// --- Version math ---

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

function bumpVersion(current: string, bump: string): string {
  const s = parseSemver(current)
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump
  const isPre = s.prerelease !== null

  switch (bump) {
    case 'prerelease': {
      if (!isPre) return `${s.major}.${s.minor}.${s.patch}-beta.0`
      const parts = s.prerelease.split('.')
      parts[parts.length - 1] = String(+parts[parts.length - 1] + 1)
      return `${s.major}.${s.minor}.${s.patch}-${parts.join('.')}`
    }
    case 'patch':
      return isPre ? `${s.major}.${s.minor}.${s.patch}` : `${s.major}.${s.minor}.${s.patch + 1}`
    case 'minor':
      return `${s.major}.${s.minor + 1}.0`
    case 'major':
      return `${s.major + 1}.0.0`
    case 'prepatch':
      return `${s.major}.${s.minor}.${s.patch + 1}-beta.0`
    case 'preminor':
      return `${s.major}.${s.minor + 1}.0-beta.0`
    case 'premajor':
      return `${s.major + 1}.0.0-beta.0`
    default:
      throw new Error(`Unknown bump type: ${bump}`)
  }
}

// --- PR body extraction ---

async function getLatestMergedPR(): Promise<{
  number: number
  title: string
  body: string
} | null> {
  try {
    const result =
      await $`gh pr list --state merged --json number,title,body --limit 1 --jq '.[0]'`.text()
    const pr = JSON.parse(result.trim())
    return pr.number ? pr : null
  } catch {
    return null
  }
}

async function getPRBody(prNumber: number): Promise<string | null> {
  try {
    const result = await $`gh pr view ${prNumber} --json title,body --jq '.body'`.text()
    return result.trim() || null
  } catch {
    return null
  }
}

function formatReleaseNotes(
  versions: { name: string; from: string; to: string }[],
  prBody: string | null,
  customNotes: string | null,
): string {
  const header = versions.map((v) => `\`${v.name}\`: \`${v.from}\` → \`${v.to}\``).join('\n')

  if (customNotes) {
    return `${header}\n\n---\n\n${customNotes}`
  }

  if (prBody) {
    return `${header}\n\n---\n\n${prBody}`
  }

  return header
}

// --- Main ---

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    'dry-run': { type: 'boolean', default: false },
    package: { type: 'string' },
    'no-tag': { type: 'boolean', default: false },
    'no-publish': { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    'no-release': { type: 'boolean', default: false },
    pr: { type: 'string' },
    notes: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
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
  --no-tag           Skip git tag + commit
  --no-publish       Skip npm publish
  --no-build         Skip build step
  --no-release       Skip GitHub release
  --pr <number>      Use specific PR for release notes
  --notes <text>     Custom release notes
  --help             Show this message
`)
  process.exit(0)
}

const bump = positionals[0]
const dryRun = values['dry-run']
const onlyPackage = values.package as Package | undefined
const createTag = !values['no-tag']
const doPublish = !values['no-publish']
const doBuild = !values['no-build']
const doRelease = !values['no-release']
const customNotes = values.notes ?? null

if (onlyPackage && !PACKAGES.includes(onlyPackage)) {
  console.error(`Unknown package: ${onlyPackage}. Use: ${PACKAGES.join(' | ')}`)
  process.exit(1)
}

const targets = onlyPackage ? [PACKAGE_CONFIG[onlyPackage]] : PACKAGES.map((p) => PACKAGE_CONFIG[p])

console.log(`\n📦 Release plan (${dryRun ? 'DRY RUN' : 'LIVE'})\n`)

interface ReleasePlan {
  config: PackageConfig
  current: string
  next: string
}

const plan: ReleasePlan[] = []

for (const config of targets) {
  const pkg = JSON.parse(readFileSync(config.path, 'utf-8'))
  const current: string = pkg.version
  const next = bumpVersion(current, bump)
  plan.push({ config, current, next })
  const arrow = current === next ? '(no change)' : `→ ${next}`
  console.log(`  ${config.name}: ${current} ${arrow}`)
}

console.log()

if (dryRun) {
  // Show what the release notes would look like
  if (doRelease) {
    console.log('📝 Release notes preview:\n')
    if (customNotes) {
      console.log(`  Using custom notes: "${customNotes.slice(0, 80)}..."`)
    } else {
      const pr = values.pr ? null : await getLatestMergedPR()
      const prNum = values.pr ? +values.pr[0] : pr?.number
      const prBody = prNum ? await getPRBody(prNum) : null
      if (prBody) {
        console.log(`  From PR #${prNum} (${pr?.title ?? ''})`)
        console.log(`  ${prBody.split('\n')[0]}...`)
      } else {
        console.log('  (no PR found — version header only)')
      }
    }
    console.log()
  }
  console.log('Dry run — no changes made.\n')
  process.exit(0)
}

// --- Bump versions ---

for (const { config, next } of plan) {
  const pkg = JSON.parse(readFileSync(config.path, 'utf-8'))
  pkg.version = next
  writeFileSync(config.path, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`✅ Bumped ${config.name} to ${next}`)
}

// --- Build ---

if (doBuild) {
  console.log('\n🔨 Building...')
  for (const { config } of plan) {
    try {
      await $`cd ${join(ROOT, 'packages', config.name)} && bun run build`.quiet()
      console.log(`  ✅ ${config.name} built`)
    } catch {
      console.error(`  ❌ ${config.name} build failed`)
      process.exit(1)
    }
  }
}

// --- Publish ---

if (doPublish) {
  console.log('\n🚀 Publishing...')
  for (const { config, next } of plan) {
    try {
      const tag = next.includes('beta') || next.includes('alpha') ? 'next' : config.npmTag
      await $`cd ${join(ROOT, 'packages', config.name)} && npm publish --tag ${tag}`.quiet()
      console.log(`  ✅ ${config.name}@${next} published (${tag})`)
    } catch {
      console.error(`  ❌ ${config.name} publish failed`)
      process.exit(1)
    }
  }
}

// --- Git commit + tag + push ---

if (createTag) {
  console.log('\n🏷️  Committing & tagging...')
  for (const { config, next } of plan) {
    const tagName = `${config.name}@${next}`
    await $`git add ${config.path}`
    await $`git commit -m "release: ${tagName}"`
    await $`git tag ${tagName}`
    console.log(`  ✅ ${tagName}`)
  }

  console.log('\n  Pushing...')
  await $`git push`.quiet()
  await $`git push --tags`.quiet()
  console.log('  ✅ Pushed commits + tags')
}

// --- GitHub releases ---

if (doRelease) {
  console.log('\n📦 Creating GitHub releases...')

  // Resolve PR body once for all packages
  let prBody: string | null = null
  let prNumber: number | undefined
  if (!customNotes) {
    if (values.pr) {
      prNumber = +values.pr[0]
      prBody = await getPRBody(prNumber)
    } else {
      const pr = await getLatestMergedPR()
      if (pr) {
        prNumber = pr.number
        prBody = pr.body
      }
    }
  }

  // Create a release per package
  for (const { config, next } of plan) {
    const tagName = `${config.name}@${next}`
    const notes = formatReleaseNotes(
      [
        {
          name: config.name,
          from: plan.find((p) => p.config.name === config.name)!.current,
          to: next,
        },
      ],
      prBody,
      customNotes,
    )

    try {
      await $`gh release create ${tagName} --title ${tagName} --notes ${notes}`.quiet()
      console.log(`  ✅ ${tagName} released on GitHub`)
    } catch {
      console.error(`  ❌ Failed to create release for ${tagName}`)
    }
  }

  if (prNumber) {
    console.log(`\n  📝 Release notes from PR #${prNumber}`)
  }
}

console.log('\n🎉 Done!\n')

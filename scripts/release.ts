#!/usr/bin/env bun
/**
 * Release script for duron and duron-dashboard.
 *
 * Usage:
 *   bun run scripts/release.ts <bump> [--dry-run]
 *
 * Flow:
 *   1. Check if current version is already published on npm
 *   2. If NOT published → publish current version (no bump)
 *   3. If published → bump version → git commit + tag → build → publish → push → GitHub release
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
 *   --no-publish    Skip npm publish
 *   --no-build      Skip build step before publish
 *   --no-release    Skip GitHub release creation
 *   --pr <number>   Use specific PR for release notes (default: latest merged)
 *   --notes <text>  Custom release notes (instead of PR description)
  --otp <code>   npm one-time password for 2FA (prompted if not provided)
 */

import { readFileSync } from 'fs'
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

// --- Check if version is published on npm ---

async function isVersionPublished(name: string, version: string): Promise<boolean> {
  try {
    await $`npm view ${name}@${version} version`.quiet()
    return true
  } catch {
    return false
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
    'no-publish': { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    'no-release': { type: 'boolean', default: false },
    pr: { type: 'string' },
    notes: { type: 'string' },
    otp: { type: 'string' },
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
  --no-publish       Skip npm publish
  --no-build         Skip build step
  --no-release       Skip GitHub release
  --pr <number>      Use specific PR for release notes
  --notes <text>     Custom release notes
  --otp <code>       npm one-time password (prompted if not provided)
  --help             Show this message
`)
  process.exit(0)
}

const bump = positionals[0]
const dryRun = values['dry-run']
const onlyPackage = values.package as Package | undefined
const doPublish = !values['no-publish']
const doBuild = !values['no-build']
const doRelease = !values['no-release']
const customNotes = values.notes ?? null
const otpArg = values.otp ?? null

if (onlyPackage && !PACKAGES.includes(onlyPackage)) {
  console.error(`Unknown package: ${onlyPackage}. Use: ${PACKAGES.join(' | ')}`)
  process.exit(1)
}

const targets = onlyPackage ? [PACKAGE_CONFIG[onlyPackage]] : PACKAGES.map((p) => PACKAGE_CONFIG[p])

console.log(`\n📦 Release plan (${dryRun ? 'DRY RUN' : 'LIVE'})\n`)

// --- Check current state ---

interface ReleasePlan {
  config: PackageConfig
  current: string
  published: boolean
  next: string
}

const plan: ReleasePlan[] = []

for (const config of targets) {
  const pkg = JSON.parse(readFileSync(config.path, 'utf-8'))
  const current: string = pkg.version
  const published = await isVersionPublished(config.name, current)
  const next = published ? bumpVersion(current, bump) : current
  plan.push({ config, current, published, next })
  const status = published ? 'published → bump' : 'not published → publish as-is'
  console.log(`  ${config.name}: ${current} (${status}${published ? ` → ${next}` : ''})`)
}

console.log()

if (dryRun) {
  console.log('Dry run — no changes made.\n')
  process.exit(0)
}

// --- Step 1: Bump versions + git commit + tag (only for published versions) ---

for (const item of plan) {
  if (item.published) {
    console.log(`\n🏷️  Bumping ${item.config.name}: ${item.current} → ${item.next}`)
    // Write new version to package.json
    const pkg = JSON.parse(readFileSync(item.config.path, 'utf-8'))
    pkg.version = item.next
    Bun.write(item.config.path, JSON.stringify(pkg, null, 2) + '\n')

    // Git commit + tag
    const tagName = `${item.config.name}@${item.next}`
    await $`git add ${item.config.path}`
    await $`git commit -m "release: ${tagName}"`
    await $`git tag ${tagName}`
    console.log(`  ✅ Committed & tagged: ${tagName}`)
  }
}

// --- Step 2: Build ---

if (doBuild) {
  console.log('\n🔨 Building...')
  for (const item of plan) {
    try {
      await $`cd ${join(ROOT, 'packages', item.config.name)} && bun run build`.quiet()
      console.log(`  ✅ ${item.config.name} built`)
    } catch {
      console.error(`  ❌ ${item.config.name} build failed`)
      process.exit(1)
    }
  }
}

// --- Step 3: Publish ---

if (doPublish) {
  // Prompt for OTP if not provided via --otp
  let otp = otpArg
  if (!otp) {
    process.stdout.write('\n🔐 Enter npm one-time password (OTP): ')
    otp = await new Promise<string>((resolve) => {
      process.stdin.setEncoding('utf-8')
      process.stdin.resume()
      process.stdin.once('data', (data) => {
        process.stdin.pause()
        resolve(data.trim())
      })
    })
    if (!otp) {
      console.error('❌ No OTP provided. Aborting publish.')
      process.exit(1)
    }
  }

  console.log('\n🚀 Publishing...')
  for (const item of plan) {
    try {
      const tag = item.next.includes('beta') || item.next.includes('alpha') ? 'next' : item.config.npmTag
      await $`cd ${join(ROOT, 'packages', item.config.name)} && npm publish --tag ${tag} --otp ${otp}`.quiet()
      console.log(`  ✅ ${item.config.name}@${item.next} published (${tag})`)
    } catch (e: any) {
      console.error(`  ❌ ${item.config.name} publish failed`)
      const stdout = e?.stdout?.toString?.() || ''
      const stderr = e?.stderr?.toString?.() || ''
      const msg = e?.message?.toString?.() || String(e)
      if (stdout) console.error(stdout)
      if (stderr) console.error(stderr)
      if (!stdout && !stderr) console.error(msg)
      process.exit(1)
    }
  }
}

// --- Step 4: Push commits + tags ---

console.log('\n  Pushing...')
await $`git push`.quiet()
await $`git push --tags`.quiet()
console.log('  ✅ Pushed commits + tags')

// --- Step 5: GitHub releases ---

if (doRelease) {
  console.log('\n📦 Creating GitHub releases...')

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

  for (const item of plan) {
    const tagName = `${item.config.name}@${item.next}`
    const notes = formatReleaseNotes(
      [{ name: item.config.name, from: item.current, to: item.next }],
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

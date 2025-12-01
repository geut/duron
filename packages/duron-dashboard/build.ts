#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: This is a build script
import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'

import plugin from 'bun-plugin-tailwind'

import pkg from './package.json'

const formatFileSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

console.log('\n🚀 Starting build process...\n')

const outdir = path.join(process.cwd(), 'dist')

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`)
  await rm(outdir, { recursive: true, force: true })
}

const start = performance.now()

// Check if entrypoints are provided via CLI
const entrypoints = [...new Bun.Glob('**.html').scanSync('src')]
  .map((a) => path.resolve('src', a))
  .filter((dir) => !dir.includes('node_modules'))
console.log(`📄 Found ${entrypoints.length} HTML ${entrypoints.length === 1 ? 'file' : 'files'} to process\n`)

const [indexResult, initResult] = await Promise.all([
  Bun.build({
    entrypoints: ['src/index.tsx'],
    outdir,
    plugins: [plugin],
    format: 'esm',
    target: 'browser',
    sourcemap: 'linked',
    external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)],
  }),
  Bun.build({
    entrypoints: ['src/init.tsx'],
    outdir,
    plugins: [plugin],
    format: 'esm',
    minify: true,
    target: 'browser',
    sourcemap: 'linked',
  }),
])

await cp(path.join(import.meta.dirname, '..', 'assets', 'favicon.svg'), path.join(outdir, 'favicon.svg'))

const end = performance.now()

const outputTable = [...indexResult.outputs, ...initResult.outputs].map((output) => ({
  File: path.relative(process.cwd(), output.path),
  Type: output.kind,
  Size: formatFileSize(output.size),
}))

console.table(outputTable)
const buildTime = (end - start).toFixed(2)

console.log(`\n✅ Build completed in ${buildTime}ms\n`)

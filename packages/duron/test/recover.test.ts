import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod/mini'

import { defineAction } from '../src/action.js'
import { PostgresAdapter } from '../src/adapters/postgres/postgres.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_ACTIVE, JOB_STATUS_COMPLETED, JOB_STATUS_CREATED } from '../src/constants.js'

import { type AdapterFactory, postgresFactory } from './adapters.js'
import { expectToBeDefined } from './asserts.js'

// =============================================================================
// Test Actions - must be defined identically in worker
// =============================================================================

const slowAction = defineAction()({
  name: 'slow-action',
  version: '1.0.0',
  input: z.object({
    delay: z.number(),
  }),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    await ctx.step('slow-step', async ({ signal }) => {
      // Slow step that can be interrupted
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, ctx.input.delay)
        signal.addEventListener('abort', () => {
          clearTimeout(timeout)
          reject(new Error('Aborted'))
        })
      })
      return { processed: true }
    })
    return { result: 'completed' }
  },
})

const quickAction = defineAction()({
  name: 'quick-action',
  version: '1.0.0',
  input: z.object({
    message: z.string(),
  }),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    return { result: `Processed: ${ctx.input.message}` }
  },
})

// =============================================================================
// Worker Script Content
// =============================================================================

// Get the absolute path to the duron package src directory
const duronSrcPath = import.meta.dir.replace('/test', '/src')

/**
 * Creates a worker script that runs a Duron client to process jobs.
 * The worker will:
 * 1. Connect to the database
 * 2. Process jobs using the hybrid sync pattern
 * 3. Write a ready file to signal readiness
 * 4. Exit when killed
 */
function createWorkerScript(
  connectionUrl: string,
  workerId: string,
  readyFilePath: string,
): string {
  return `
import { z } from 'zod/mini'
import { defineAction } from '${duronSrcPath}/action.js'
import { Client } from '${duronSrcPath}/client.js'
import { PostgresAdapter } from '${duronSrcPath}/adapters/postgres/postgres.js'

// Define the same actions as the host
const slowAction = defineAction()({
  name: 'slow-action',
  version: '1.0.0',
  input: z.object({
    delay: z.number(),
  }),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    await ctx.step('slow-step', async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, ctx.input.delay)
        signal.addEventListener('abort', () => {
          clearTimeout(timeout)
          reject(new Error('Aborted'))
        })
      })
      return { processed: true }
    })
    return { result: 'completed' }
  },
})

const quickAction = defineAction()({
  name: 'quick-action',
  version: '1.0.0',
  input: z.object({
    message: z.string(),
  }),
  output: z.object({
    result: z.string(),
  }),
  handler: async (ctx) => {
    return { result: \`Processed: \${ctx.input.message}\` }
  },
})

// Create the worker client
const client = new Client({
  id: '${workerId}',
  database: new PostgresAdapter({
    connection: '${connectionUrl}',
    migrateOnStart: false,
  }),
  actions: {
    slowAction,
    quickAction,
  },
  syncPattern: 'hybrid',
  pullInterval: 100,
  batchSize: 10,
  recoverJobsOnStart: false,
  logger: 'error',
})

// Start the client
await client.start()

// Signal that worker is ready by creating a file
await Bun.write('${readyFilePath}', 'ready')

// Handle graceful shutdown (won't be called when force killed)
process.on('SIGTERM', async () => {
  await client.stop()
  process.exit(0)
})

// Keep the worker alive
await new Promise(() => {})
`
}

// =============================================================================
// Helper to create a new adapter with its own connection
// =============================================================================

function createAdapter(connectionUrl: string) {
  return new PostgresAdapter({
    connection: connectionUrl,
    migrateOnStart: false,
  })
}

// =============================================================================
// Test Suite
// =============================================================================

/**
 * Recover tests require a real database that supports multi-process access,
 * so we only test with PostgreSQL (not PGLite which is in-memory).
 */
function runRecoverTests(adapterFactory: AdapterFactory) {
  describe(`Recover Tests with ${adapterFactory.name}`, () => {
    let connectionUrl: string
    let deleteDb: () => Promise<void>
    let workerProcess: import('bun').Subprocess | null = null
    const clientsToStop: Client<any, any>[] = []

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create({})
        connectionUrl = adapterInstance.connectionUrl
        deleteDb = adapterInstance.deleteDb

        // Create a temporary client just to run migrations
        const migrationClient = new Client({
          id: 'migration-client',
          database: adapterInstance.adapter,
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })
        await migrationClient.start()
        await migrationClient.stop()
      },
      {
        timeout: 60_000,
      },
    )

    afterEach(async () => {
      // Kill worker if still running
      if (workerProcess) {
        workerProcess.kill()
        workerProcess = null
      }

      // Stop all clients
      for (const client of clientsToStop) {
        try {
          await client.stop()
        } catch {
          // Ignore stop errors during cleanup
        }
      }
      clientsToStop.length = 0

      if (deleteDb) {
        await deleteDb()
      }
    })

    /**
     * Spawns a worker subprocess that processes jobs.
     * Returns a promise that resolves when the worker is ready.
     */
    async function spawnWorker(workerId: string): Promise<import('bun').Subprocess> {
      const timestamp = Date.now()
      const tempScriptPath = `/tmp/duron-worker-${workerId}-${timestamp}.ts`
      const readyFilePath = `/tmp/duron-worker-${workerId}-${timestamp}.ready`

      const scriptContent = createWorkerScript(connectionUrl, workerId, readyFilePath)

      // Write the worker script to a temp file
      await Bun.write(tempScriptPath, scriptContent)

      // Spawn the worker process
      const proc = Bun.spawn(['bun', 'run', tempScriptPath], {
        cwd: import.meta.dir.replace('/test', ''),
        stdout: 'inherit',
        stderr: 'inherit',
      })

      // Poll for the ready file
      const startTime = Date.now()
      const timeout = 10_000

      while (Date.now() - startTime < timeout) {
        const readyFile = Bun.file(readyFilePath)
        if (await readyFile.exists()) {
          // Cleanup ready file
          await Bun.$`rm -f ${readyFilePath}`.quiet()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (Date.now() - startTime >= timeout) {
        proc.kill()
        throw new Error('Worker startup timeout')
      }

      // Schedule cleanup of temp script file
      setTimeout(async () => {
        try {
          await Bun.$`rm -f ${tempScriptPath}`.quiet()
        } catch {
          // Ignore cleanup errors
        }
      }, 5000)

      return proc
    }

    describe('Single Process Recovery', () => {
      it('should recover a job from the same client ID after restart', async () => {
        // 1. Create host client to create jobs
        const hostClient = new Client({
          id: 'host-client',
          database: createAdapter(connectionUrl),
          actions: { slowAction, quickAction },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })
        clientsToStop.push(hostClient)
        await hostClient.start()

        // Create a job
        const jobId = await hostClient.runAction('slowAction', { delay: 30_000 })

        // 2. Create a processing client with the same ID that will fetch and start the job
        const processingClient = new Client({
          id: 'processing-client',
          database: createAdapter(connectionUrl),
          actions: { slowAction, quickAction },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })
        clientsToStop.push(processingClient)
        await processingClient.start()

        // Fetch and start processing the job
        await processingClient.fetch({ batchSize: 10 })

        // Wait a bit for the job to start
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Verify job is now active
        let job = await hostClient.getJobById(jobId)
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_ACTIVE)

        // 3. Simulate a crash by NOT calling stop() gracefully
        // The processing client still has the job active
        // In a real crash scenario, the process would die here

        // 4. Create a new recovery client with the SAME ID as processing client
        // This simulates the same process restarting
        const recoveryClient = new Client({
          id: 'processing-client', // Same ID as the "crashed" client
          database: createAdapter(connectionUrl),
          actions: { slowAction, quickAction },
          syncPattern: false,
          recoverJobsOnStart: true, // Enable recovery
          logger: 'error',
        })
        clientsToStop.push(recoveryClient)
        await recoveryClient.start()

        // 5. Verify job was recovered (status should be 'created' again)
        job = await recoveryClient.getJobById(jobId)
        expectToBeDefined(job)
        expect(job.status).toBe(JOB_STATUS_CREATED)
      })
    })

    describe('Multi-Process Recovery', () => {
      it(
        'should recover jobs from a crashed worker process',
        async () => {
          const workerId = `worker-${Date.now()}`

          // 1. Create host client to create jobs
          const hostClient = new Client({
            id: 'host-client',
            database: createAdapter(connectionUrl),
            actions: { slowAction, quickAction },
            syncPattern: false,
            recoverJobsOnStart: false,
            logger: 'error',
          })
          clientsToStop.push(hostClient)
          await hostClient.start()

          // 2. Spawn a worker that will process jobs
          workerProcess = await spawnWorker(workerId)

          // 3. Create a slow job from the host
          const jobId = await hostClient.runAction('slowAction', { delay: 60_000 })

          // 4. Wait for the worker to pick up the job
          await new Promise((resolve) => setTimeout(resolve, 500))

          // Verify job is being processed
          let job = await hostClient.getJobById(jobId)
          expectToBeDefined(job)
          expect(job.status).toBe(JOB_STATUS_ACTIVE)

          // 5. Kill the worker process abruptly (simulating a crash)
          workerProcess.kill(9) // SIGKILL - immediate termination
          workerProcess = null

          // 6. Wait a moment for the worker to die
          await new Promise((resolve) => setTimeout(resolve, 100))

          // 7. Create a recovery client that will recover jobs from dead processes
          const recoveryClient = new Client({
            id: 'recovery-client',
            database: createAdapter(connectionUrl),
            actions: { slowAction, quickAction },
            syncPattern: false,
            recoverJobsOnStart: true,
            heartbeatInterval: 500,
            heartbeatTimeout: 1_000,
            logger: 'error',
          })
          clientsToStop.push(recoveryClient)
          await recoveryClient.start()

          // 8. Verify job was recovered (status should be 'created' again)
          job = await recoveryClient.getJobById(jobId)
          expectToBeDefined(job)
          expect(job.status).toBe(JOB_STATUS_CREATED)
        },
        { timeout: 30_000 },
      )

      it(
        'should not recover jobs from a live worker process',
        async () => {
          const workerId = `worker-${Date.now()}`

          // 1. Create host client
          const hostClient = new Client({
            id: 'host-client',
            database: createAdapter(connectionUrl),
            actions: { slowAction, quickAction },
            syncPattern: false,
            recoverJobsOnStart: false,
            logger: 'error',
          })
          clientsToStop.push(hostClient)
          await hostClient.start()

          // 2. Spawn a worker that will process jobs
          workerProcess = await spawnWorker(workerId)

          // 3. Create a slow job from the host
          const jobId = await hostClient.runAction('slowAction', { delay: 60_000 })

          // 4. Wait for the worker to pick up the job
          await new Promise((resolve) => setTimeout(resolve, 500))

          // Verify job is being processed
          let job = await hostClient.getJobById(jobId)
          expectToBeDefined(job)
          expect(job.status).toBe(JOB_STATUS_ACTIVE)

          // 5. Create a recovery client - worker is still alive
          const recoveryClient = new Client({
            id: 'recovery-client',
            database: createAdapter(connectionUrl),
            actions: { slowAction, quickAction },
            syncPattern: false,
            recoverJobsOnStart: true,
            heartbeatInterval: 500,
            heartbeatTimeout: 1_000,
            logger: 'error',
          })
          clientsToStop.push(recoveryClient)
          await recoveryClient.start()

          // 6. Verify job was NOT recovered (worker is still alive and responding to pings)
          job = await recoveryClient.getJobById(jobId)
          expectToBeDefined(job)
          expect(job.status).toBe(JOB_STATUS_ACTIVE) // Still active, not recovered

          // Cleanup: kill the worker
          if (workerProcess) {
            workerProcess.kill()
            workerProcess = null
          }
        },
        { timeout: 30_000 },
      )

      it(
        'should recover and complete a job after worker crash',
        async () => {
          const workerId = `worker-${Date.now()}`

          // 1. Create host client
          const hostClient = new Client({
            id: 'host-client',
            database: createAdapter(connectionUrl),
            actions: { slowAction, quickAction },
            syncPattern: false,
            recoverJobsOnStart: false,
            logger: 'error',
          })
          clientsToStop.push(hostClient)
          await hostClient.start()

          // 2. Spawn a worker that will process jobs
          workerProcess = await spawnWorker(workerId)

          // 3. Create a quick job from the host
          const jobId = await hostClient.runAction('quickAction', { message: 'recover-me' })

          // 4. Create a slow job and wait for it to start
          const slowJobId = await hostClient.runAction('slowAction', { delay: 30_000 })

          await new Promise((resolve) => setTimeout(resolve, 300))

          // Verify slow job is being processed
          const activeJob = await hostClient.getJobById(slowJobId)
          expectToBeDefined(activeJob)
          expect(activeJob.status).toBe(JOB_STATUS_ACTIVE)

          // 5. Kill the worker
          workerProcess.kill(9)
          workerProcess = null

          await new Promise((resolve) => setTimeout(resolve, 100))

          // 6. Create a recovery client that will also process jobs
          const recoveryClient = new Client({
            id: 'recovery-client',
            database: createAdapter(connectionUrl),
            actions: { slowAction, quickAction },
            syncPattern: 'pull',
            pullInterval: 100,
            recoverJobsOnStart: true,
            heartbeatInterval: 500,
            heartbeatTimeout: 1_000,
            logger: 'error',
          })
          clientsToStop.push(recoveryClient)
          await recoveryClient.start()

          // 7. Wait for jobs to be recovered and processed
          await new Promise((resolve) => setTimeout(resolve, 2500))

          // 8. Verify quick job was completed
          const quickJob = await recoveryClient.getJobById(jobId)
          expectToBeDefined(quickJob)
          expect(quickJob.status).toBe(JOB_STATUS_COMPLETED)
          expect(quickJob.output).toEqual({ result: 'Processed: recover-me' })
        },
        { timeout: 30_000 },
      )
    })
  })
}

// Only run with PostgreSQL since PGLite doesn't support multi-process
// oxlint-disable-next-line useLiteralKeys
if (process.env['POSTGRES_TEST'] === 'true') {
  runRecoverTests(postgresFactory)
}

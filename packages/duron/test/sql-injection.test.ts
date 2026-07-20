import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_CREATED } from '../src/constants.js'

import { type AdapterFactory, pgliteFactory, postgresFactory } from './adapters.js'

function runSqlInjectionTests(adapterFactory: AdapterFactory) {
  describe(`SQL Injection Tests with ${adapterFactory.name}`, () => {
    let client: Client<any, any>
    let deleteDb: () => Promise<void>

    const testAction = defineAction()({
      name: 'test-action',
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

    beforeEach(
      async () => {
        const adapterInstance = await adapterFactory.create({})
        deleteDb = adapterInstance.deleteDb

        client = new Client({
          database: adapterInstance.adapter,
          actions: {
            testAction,
          },
          syncPattern: false,
          recoverJobsOnStart: false,
          logger: 'error',
        })

        await client.start()
      },
      {
        timeout: 60_000,
      },
    )

    afterEach(async () => {
      if (client) {
        await client.stop()
      }
      if (deleteDb) {
        await deleteDb()
      }
    })

    describe('Finding #1: SQL injection via groupKey array filter', () => {
      it('should safely handle groupKey with SQL injection attempt (single quote)', async () => {
        // Create a job with a normal group key
        await client.runAction('testAction', {
          message: 'normal job',
        })

        // Try to inject SQL via groupKey array filter
        // Before fix: sql.raw would interpolate this directly into the SQL string
        // The single quote breaks out of the string literal: 'value'); DROP TABLE --
        const maliciousGroupKey = "'; DROP TABLE jobs_active; --"

        // This should NOT throw an error or corrupt the database
        // It should either return empty results or handle the input safely
        const adapter = (client as any).database
        const result = await adapter.getJobs({
          filters: {
            groupKey: [maliciousGroupKey],
          },
        })

        // The query should complete without error
        expect(result).toBeDefined()
        expect(result.jobs).toBeDefined()
        expect(Array.isArray(result.jobs)).toBe(true)

        // Verify the database is still intact by creating another job
        const jobId = await client.runAction('testAction', {
          message: 'after injection attempt',
        })
        expect(jobId).toBeDefined()

        // Verify we can still query jobs
        const normalResult = await adapter.getJobs({
          filters: {},
        })
        expect(normalResult.jobs.length).toBeGreaterThanOrEqual(2)
      })

      it('should safely handle groupKey with SQL injection attempt (escape characters)', async () => {
        await client.runAction('testAction', {
          message: 'test job',
        })

        // Various SQL injection patterns
        const maliciousKeys = [
          "test' OR '1'='1",
          "test') OR ('1'='1",
          "test'; SELECT * FROM users; --",
          "test' UNION SELECT null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null --",
        ]

        const adapter = (client as any).database

        for (const maliciousKey of maliciousKeys) {
          // Each of these should be handled safely
          const result = await adapter.getJobs({
            filters: {
              groupKey: [maliciousKey],
            },
          })

          expect(result).toBeDefined()
          expect(result.jobs).toBeDefined()
          expect(Array.isArray(result.jobs)).toBe(true)
        }

        // Database should still be functional
        const jobId = await client.runAction('testAction', {
          message: 'after all injection attempts',
        })
        expect(jobId).toBeDefined()
      })
    })

    describe('Finding #2: SQL injection via inputFilter/outputFilter JSONB', () => {
      it('should safely handle inputFilter with single quote in string value', async () => {
        // Create a job with input containing a single quote
        await client.runAction('testAction', {
          message: "it's a test",
        })

        const adapter = (client as any).database

        // Try to filter using a value with a single quote
        // Before fix: JSON.stringify would not escape the quote
        const result = await adapter.getJobs({
          filters: {
            inputFilter: {
              message: "it's",
            },
          },
        })

        // The query should complete without error
        expect(result).toBeDefined()
        expect(result.jobs).toBeDefined()
        expect(Array.isArray(result.jobs)).toBe(true)

        // Should find the job with the quote in input
        expect(result.jobs.length).toBe(1)
        expect(result.jobs[0]!.input.message).toBe("it's a test")
      })

      it('should safely handle inputFilter with SQL injection in JSONB value', async () => {
        await client.runAction('testAction', {
          message: 'normal message',
        })

        const adapter = (client as any).database

        // SQL injection attempt via JSONB filter value
        const maliciousFilter = {
          message: "'; DROP TABLE jobs_active; --",
        }

        // This should NOT throw or corrupt the database
        const result = await adapter.getJobs({
          filters: {
            inputFilter: maliciousFilter,
          },
        })

        expect(result).toBeDefined()
        expect(result.jobs).toBeDefined()
        expect(Array.isArray(result.jobs)).toBe(true)

        // Database should still be functional
        const jobId = await client.runAction('testAction', {
          message: 'after injection attempt',
        })
        expect(jobId).toBeDefined()
      })

      // Note: outputFilter test skipped here because it requires waitForJob
      // which has a TOCTOU race (Finding #5). The SQL injection fix for outputFilter
      // uses the same #buildJsonbWhereConditions method as inputFilter, so the
      // inputFilter test above validates the fix.
    })
  })
}

describe('SQL Injection Tests', () => {
  runSqlInjectionTests(postgresFactory)
  runSqlInjectionTests(pgliteFactory)
})

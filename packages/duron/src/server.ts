import { Elysia } from 'elysia'
import { jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

import type { GetJobStepsOptions, GetJobsOptions } from './adapters/adapter.js'
import {
  GetActionsResultSchema,
  GetJobStepsResultSchema,
  GetJobsResultSchema,
  JobSchema,
  JobSortFieldSchema,
  JobStatusResultSchema,
  JobStatusSchema,
  JobStepSchema,
  JobStepStatusResultSchema,
  SortOrderSchema,
} from './adapters/schemas.js'
import type { Client } from './client.js'

// ============================================================================
// Custom Errors
// ============================================================================

/**
 * Error thrown when a requested resource is not found.
 */
export class NotFoundError extends Error {
  /**
   * Create a new NotFoundError.
   *
   * @param message - Error message describing what was not found
   */
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/**
 * Error thrown when authentication fails.
 */
export class UnauthorizedError extends Error {
  /**
   * Create a new UnauthorizedError.
   *
   * @param message - Error message describing the authentication failure
   */
  constructor(message: string) {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

// ============================================================================
// Zod Validation Schemas
// ============================================================================

// Note: JobStatusSchema, JobSortFieldSchema, SortOrderSchema, JobSchema,
// JobStepSchema, GetJobStepsResultSchema, GetJobsResultSchema, and
// GetActionsResultSchema are imported from ./adapters/schemas.js to avoid duplication

export const GetJobStepsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(1000).optional(),
    search: z.string().optional(),
    fUpdatedAfter: z.coerce.date().optional(),
  })
  .transform((data) => ({
    page: data.page,
    pageSize: data.pageSize,
    search: data.search,
    updatedAfter: data.fUpdatedAfter,
  }))

// Reuse GetJobStepsResultSchema from schemas.ts
export const GetJobStepsResponseSchema = GetJobStepsResultSchema

export const GetJobsQuerySchema = z
  .object({
    // Pagination
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(1000).optional(),

    // Filters - arrays can be passed as comma-separated or multiple params
    fStatus: z.union([JobStatusSchema, z.array(JobStatusSchema)]).optional(),
    fActionName: z.union([z.string(), z.array(z.string())]).optional(),
    fGroupKey: z.union([z.string(), z.array(z.string())]).optional(),
    fClientId: z.union([z.string(), z.array(z.string())]).optional(),
    // Date filters: can be a single ISO string or JSON array [start, end] - both coerced to Date objects
    fCreatedAt: z.union([z.coerce.date(), z.array(z.coerce.date())]).optional(),
    fStartedAt: z.union([z.coerce.date(), z.array(z.coerce.date())]).optional(),
    fFinishedAt: z.union([z.coerce.date(), z.array(z.coerce.date())]).optional(),
    fUpdatedAfter: z.coerce.date().optional(),
    fSearch: z.string().optional(),

    // Sort - format: "field:asc,field:desc"
    sort: z.string().optional(),

    // JSONB filters as JSON strings
    fInputFilter: z.record(z.string(), z.any()).optional(),
    fOutputFilter: z.record(z.string(), z.any()).optional(),
  })
  .transform((data) => {
    const filters: any = {}

    if (data.fStatus) filters.status = data.fStatus
    if (data.fActionName) filters.actionName = data.fActionName
    if (data.fGroupKey) filters.groupKey = data.fGroupKey
    if (data.fClientId) filters.clientId = data.fClientId
    if (data.fCreatedAt) filters.createdAt = data.fCreatedAt
    if (data.fStartedAt) filters.startedAt = data.fStartedAt
    if (data.fFinishedAt) filters.finishedAt = data.fFinishedAt
    if (data.fUpdatedAfter) filters.updatedAfter = data.fUpdatedAfter
    if (data.fSearch) filters.search = data.fSearch
    if (data.fInputFilter) filters.inputFilter = data.fInputFilter
    if (data.fOutputFilter) filters.outputFilter = data.fOutputFilter

    // Parse sort string: "field:asc,field:desc" -> [{ field: 'field', order: 'asc' }, { field: 'field', order: 'desc' }]
    let sort: Array<{ field: z.infer<typeof JobSortFieldSchema>; order: z.infer<typeof SortOrderSchema> }> | undefined
    if (data.sort) {
      const sortParts = data.sort
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      const parsedSorts = sortParts
        .map((part) => {
          const [field, order] = part.split(':').map((s) => s.trim())
          if (!field || !order) {
            return null
          }
          // Validate field and order
          const fieldResult = JobSortFieldSchema.safeParse(field)
          const orderResult = SortOrderSchema.safeParse(order.toLowerCase())
          if (!fieldResult.success || !orderResult.success) {
            return null
          }
          return {
            field: fieldResult.data,
            order: orderResult.data,
          }
        })
        .filter(
          (s): s is { field: z.infer<typeof JobSortFieldSchema>; order: z.infer<typeof SortOrderSchema> } => s !== null,
        )

      // If no valid sorts were parsed, set to undefined
      if (parsedSorts.length === 0) {
        sort = undefined
      } else {
        sort = parsedSorts
      }
    }

    return {
      page: data.page,
      pageSize: data.pageSize,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      sort,
    }
  })

// Reuse GetJobsResultSchema from schemas.ts
export const GetJobsResponseSchema = GetJobsResultSchema

// Reuse GetActionsResultSchema from schemas.ts
export const GetActionsResponseSchema = GetActionsResultSchema

export const GetActionsMetadataResponseSchema = z.array(
  z.object({
    name: z.string(),
    mockInput: z.any(),
  }),
)

// Export query input types for use in clients
export type GetJobsQueryInput = z.input<typeof GetJobsQuerySchema>
export type GetJobStepsQueryInput = z.input<typeof GetJobStepsQuerySchema>

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
})

const JobIdParamsSchema = z.object({
  id: z.uuid(),
})

const StepIdParamsSchema = z.object({
  id: z.uuid(),
})

export const CancelJobResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
})

export const RetryJobResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  newJobId: z.string(),
})

// ============================================================================
// Server Factory
// ============================================================================

export interface CreateServerOptions<P extends string> {
  /**
   * The Duron instance to use for the API endpoints
   */
  client: Client<any, any>

  /**
   * Optional prefix for all routes (default: '/api')
   */
  prefix?: P

  login?: {
    onLogin: (body: { email: string; password: string }) => Promise<boolean>
    jwtSecret: string | Uint8Array
    /**
     * Optional expiration time for the access JWT token (default: '1h')
     */
    expirationTime?: string
    /**
     * Optional expiration time for the refresh token (default: '7d')
     */
    refreshTokenExpirationTime?: string
  }
}

/**
 * Creates an Elysia server instance with duron API endpoints.
 * All endpoints use Zod for input and response validation.
 *
 * @param options - Configuration options
 * @returns Elysia server instance
 */
export function createServer<P extends string>({ client, prefix, login }: CreateServerOptions<P>) {
  // Convert string secret to Uint8Array if needed
  const secretKey = typeof login?.jwtSecret === 'string' ? new TextEncoder().encode(login?.jwtSecret) : login?.jwtSecret

  const routePrefix = (prefix ?? '/api') as P

  return new Elysia({
    prefix: routePrefix,
  })
    .onError(({ code, error, set }) => {
      if (code === 'VALIDATION') {
        set.status = 400
        return error
      }

      if (error instanceof NotFoundError) {
        set.status = 404
        return {
          error: 'Not found',
          message: error.message,
        }
      }

      if (error instanceof UnauthorizedError) {
        set.status = 401
        return {
          error: 'Unauthorized',
          message: error.message,
        }
      }

      // Handle other errors
      set.status = code === 'NOT_FOUND' ? 404 : 500
      return {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    })
    .macro('getUser', {
      headers: z.object({
        authorization: z.string().optional(),
      }),
      resolve: async ({ headers }) => {
        if (login) {
          const authHeader = headers.authorization
          if (!authHeader) {
            return {
              user: null,
            }
          }

          // Extract token from "Bearer <token>" format
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
          if (!token) {
            return {
              user: null,
            }
          }

          const { payload } = await jwtVerify(token, secretKey!).catch(() => {
            return {
              payload: null,
            }
          })

          return {
            user: payload,
          }
        }

        return {
          user: null,
        }
      },
    })
    .macro('auth', {
      getUser: true,
      beforeHandle: async ({ user }) => {
        if (login && !user) {
          throw new UnauthorizedError('Unauthorized')
        }
      },
    })
    .get(
      '/jobs/:id',
      async ({ params }) => {
        const job = await client.getJobById(params.id)
        if (!job) {
          throw new NotFoundError(`Job with ID ${params.id} was not found`)
        }
        return job
      },
      {
        params: JobIdParamsSchema,
        response: {
          200: JobSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/jobs/:id/steps',
      async ({ params, query }) => {
        const options: GetJobStepsOptions = {
          jobId: params.id,
          page: query.page,
          pageSize: query.pageSize,
          search: query.search,
          updatedAfter: query.updatedAfter,
        }
        return client.getJobSteps(options)
      },
      {
        params: JobIdParamsSchema,
        query: GetJobStepsQuerySchema,
        response: {
          200: GetJobStepsResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/jobs',
      async ({ query }) => {
        const options: GetJobsOptions = {
          page: query.page,
          pageSize: query.pageSize,
          filters: query.filters,
          sort: query.sort,
        }
        return client.getJobs(options)
      },
      {
        query: GetJobsQuerySchema,
        response: {
          200: GetJobsResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/steps/:id',
      async ({ params }) => {
        const step = await client.getJobStepById(params.id)
        if (!step) {
          throw new NotFoundError(`Step with ID ${params.id} was not found`)
        }
        return step
      },
      {
        params: StepIdParamsSchema,
        response: {
          200: JobStepSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/jobs/:id/status',
      async ({ params }) => {
        const status = await client.getJobStatus(params.id)
        if (!status) {
          throw new NotFoundError(`Job with ID ${params.id} was not found`)
        }
        return status
      },
      {
        params: JobIdParamsSchema,
        response: {
          200: JobStatusResultSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/steps/:id/status',
      async ({ params }) => {
        const status = await client.getJobStepStatus(params.id)
        if (!status) {
          throw new NotFoundError(`Step with ID ${params.id} was not found`)
        }
        return status
      },
      {
        params: StepIdParamsSchema,
        response: {
          200: JobStepStatusResultSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .post(
      '/jobs/:id/cancel',
      async ({ params }) => {
        await client.cancelJob(params.id)
        return {
          success: true,
          message: `Job ${params.id} has been cancelled`,
        }
      },
      {
        params: JobIdParamsSchema,
        response: {
          200: CancelJobResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .post(
      '/jobs/:id/retry',
      async ({ params }) => {
        const newJobId = await client.retryJob(params.id)
        if (!newJobId) {
          throw new Error(`Could not retry job ${params.id}. The job may not be in a retryable state.`)
        }
        return {
          success: true,
          message: `Job ${params.id} has been retried`,
          newJobId,
        }
      },
      {
        params: JobIdParamsSchema,
        response: {
          200: RetryJobResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .delete(
      '/jobs/:id',
      async ({ params }) => {
        const deleted = await client.deleteJob(params.id)
        if (!deleted) {
          throw new NotFoundError(
            `Job with ID ${params.id} was not found or cannot be deleted (active jobs cannot be deleted)`,
          )
        }
        return {
          success: true,
          message: `Job ${params.id} has been deleted`,
        }
      },
      {
        params: JobIdParamsSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .delete(
      '/jobs',
      async ({ query }) => {
        const options: GetJobsOptions = {
          page: query.page,
          pageSize: query.pageSize,
          filters: query.filters,
          sort: query.sort,
        }
        const deletedCount = await client.deleteJobs(options)
        return {
          success: true,
          message: `Deleted ${deletedCount} job(s)`,
          deletedCount,
        }
      },
      {
        query: GetJobsQuerySchema,
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
            deletedCount: z.number(),
          }),
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/actions',
      async () => {
        return client.getActions()
      },
      {
        response: {
          200: GetActionsResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .get(
      '/actions/metadata',
      async () => {
        return client.getActionsMetadata()
      },
      {
        response: {
          200: GetActionsMetadataResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .post(
      '/actions/:actionName/run',
      async ({ params, body }) => {
        const jobId = await client.runAction(params.actionName as any, body)
        return {
          success: true,
          jobId,
        }
      },
      {
        params: z.object({
          actionName: z.string(),
        }),
        body: z.any(),
        response: {
          200: z.object({
            success: z.boolean(),
            jobId: z.string(),
          }),
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
          401: ErrorResponseSchema,
        },
        auth: true,
      },
    )
    .post(
      '/login',
      async ({ body }) => {
        if (!login || !secretKey) {
          throw new Error('Login is not configured')
        }

        const { email, password } = body

        const success = await login.onLogin({ email, password })
        if (!success) {
          throw new UnauthorizedError('Invalid credentials')
        }

        // Generate access token (short-lived)
        const accessToken = await new SignJWT({ email, type: 'access' })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt()
          .setExpirationTime(login.expirationTime ?? '1h')
          .sign(secretKey)

        // Generate refresh token (long-lived)
        const refreshToken = await new SignJWT({ email, type: 'refresh' })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt()
          .setExpirationTime(login.refreshTokenExpirationTime ?? '7d')
          .sign(secretKey)

        return {
          accessToken,
          refreshToken,
        }
      },
      {
        body: z.object({
          email: z.email(),
          password: z.string(),
        }),
        response: {
          200: z.object({
            accessToken: z.string(),
            refreshToken: z.string(),
          }),
          401: ErrorResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    )
    .post(
      '/refresh',
      async ({ body }) => {
        if (!login || !secretKey) {
          throw new Error('Login is not configured')
        }

        const { refreshToken: providedRefreshToken } = body

        if (!providedRefreshToken) {
          throw new UnauthorizedError('Refresh token is required')
        }

        try {
          // Verify refresh token
          const { payload } = await jwtVerify(providedRefreshToken, secretKey)

          // Type assertion for JWT payload
          interface RefreshTokenPayload {
            email?: string
            type?: string
          }
          const typedPayload = payload as RefreshTokenPayload

          // Ensure it's a refresh token
          if (typedPayload.type !== 'refresh') {
            throw new UnauthorizedError('Invalid token type')
          }

          if (!typedPayload.email) {
            throw new UnauthorizedError('Invalid token payload')
          }

          // Generate new access token
          const accessToken = await new SignJWT({ email: typedPayload.email, type: 'access' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(login.expirationTime ?? '1h')
            .sign(secretKey)

          return {
            accessToken,
          }
        } catch {
          throw new UnauthorizedError('Invalid or expired refresh token')
        }
      },
      {
        body: z.object({
          refreshToken: z.string(),
        }),
        response: {
          200: z.object({
            accessToken: z.string(),
          }),
          401: ErrorResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    )
}

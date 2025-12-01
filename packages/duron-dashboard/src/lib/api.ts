import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ActionStats,
  GetActionsResult,
  GetJobStepsResult,
  GetJobsResult,
  Job,
  JobStep,
} from 'duron/adapters/adapter'
import type { JobStatus, StepStatus } from 'duron/constants'
import type { GetJobStepsQueryInput, GetJobsQueryInput } from 'duron/server'
import { useCallback } from 'react'

import { useApi } from '@/contexts/api-context'

// Re-export types from duron package
export type { ActionStats, GetActionsResult, Job, JobStep, JobStatus, StepStatus }

// Type aliases for query params and responses (matching duron types)
export type GetJobsParams = GetJobsQueryInput
export type GetJobsResponse = GetJobsResult
export type GetJobStepsParams = GetJobStepsQueryInput
export type GetJobStepsResponse = GetJobStepsResult

// Token refresh function
async function refreshAccessToken(baseUrl: string): Promise<string> {
  const refreshToken = localStorage.getItem('refresh_token')
  if (!refreshToken) {
    throw new Error('No refresh token available')
  }

  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const response = await fetch(`${normalizedBaseUrl}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })

  if (!response.ok) {
    // Clear tokens on refresh failure
    localStorage.removeItem('auth_token')
    localStorage.removeItem('refresh_token')
    throw new Error('Failed to refresh token')
  }

  const data = await response.json()
  localStorage.setItem('auth_token', data.accessToken)
  return data.accessToken
}

// API client functions
export function useApiRequest() {
  const { baseUrl } = useApi()

  return useCallback(
    async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
      const token = localStorage.getItem('auth_token')
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options?.headers as Record<string, string>),
      }

      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      // Ensure endpoint starts with /
      const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
      // Ensure baseUrl doesn't end with /
      const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl

      let response = await fetch(`${normalizedBaseUrl}${normalizedEndpoint}`, {
        ...options,
        headers,
      })

      // If we get a 401, try to refresh the token and retry once
      if (response.status === 401 && token && endpoint !== '/refresh' && endpoint !== '/login') {
        try {
          const newToken = await refreshAccessToken(baseUrl)
          // Retry the request with the new token
          headers.Authorization = `Bearer ${newToken}`
          response = await fetch(`${normalizedBaseUrl}${normalizedEndpoint}`, {
            ...options,
            headers,
          })
        } catch {
          // Refresh failed, return the original 401 response
          const error = await response.json().catch(() => ({ error: 'Unauthorized' }))
          throw new Error(error.message || error.error || 'Unauthorized')
        }
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(error.message || error.error || 'Request failed')
      }

      return response.json()
    },
    [baseUrl],
  )
}

// Auth API
export function useLogin() {
  const { baseUrl } = useApi()
  return useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
      const response = await fetch(`${normalizedBaseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })

      if (!response.ok) {
        let errorMessage = 'Invalid credentials'
        try {
          const error = await response.json()
          errorMessage = error.message || error.error || 'Invalid credentials'
        } catch {
          // If JSON parsing fails, use default message
          errorMessage = response.status === 401 ? 'Invalid credentials' : 'Login failed'
        }
        throw new Error(errorMessage)
      }

      const data = await response.json()
      localStorage.setItem('auth_token', data.accessToken)
      localStorage.setItem('refresh_token', data.refreshToken)
      return data
    },
  })
}

// Jobs API
export function useJobs(params: GetJobsParams = {}) {
  const apiRequest = useApiRequest()
  const queryParams = new URLSearchParams()

  if (params.page) queryParams.set('page', params.page.toString())
  if (params.pageSize) queryParams.set('pageSize', params.pageSize.toString())
  if (params.fStatus) {
    const status = Array.isArray(params.fStatus) ? params.fStatus.join(',') : params.fStatus
    queryParams.set('fStatus', status)
  }
  if (params.fActionName) {
    const action = Array.isArray(params.fActionName) ? params.fActionName.join(',') : params.fActionName
    queryParams.set('fActionName', action)
  }
  if (params.fGroupKey) {
    const group = Array.isArray(params.fGroupKey) ? params.fGroupKey.join(',') : params.fGroupKey
    queryParams.set('fGroupKey', group)
  }
  if (params.fCreatedAt) {
    if (Array.isArray(params.fCreatedAt)) {
      params.fCreatedAt.forEach((date: Date | string | number) => {
        const dateObj = date instanceof Date ? date : new Date(date)
        queryParams.append('fCreatedAt', dateObj.toISOString())
      })
    } else {
      const dateObj =
        params.fCreatedAt instanceof Date ? params.fCreatedAt : new Date(params.fCreatedAt as Date | string | number)
      queryParams.set('fCreatedAt', dateObj.toISOString())
    }
  }
  if (params.fStartedAt) {
    if (Array.isArray(params.fStartedAt)) {
      params.fStartedAt.forEach((date: Date | string | number) => {
        const dateObj = date instanceof Date ? date : new Date(date)
        queryParams.append('fStartedAt', dateObj.toISOString())
      })
    } else {
      const dateObj =
        params.fStartedAt instanceof Date ? params.fStartedAt : new Date(params.fStartedAt as Date | string | number)
      queryParams.set('fStartedAt', dateObj.toISOString())
    }
  }
  if (params.fFinishedAt) {
    if (Array.isArray(params.fFinishedAt)) {
      params.fFinishedAt.forEach((date: Date | string | number) => {
        const dateObj = date instanceof Date ? date : new Date(date)
        queryParams.append('fFinishedAt', dateObj.toISOString())
      })
    } else {
      const dateObj =
        params.fFinishedAt instanceof Date ? params.fFinishedAt : new Date(params.fFinishedAt as Date | string | number)
      queryParams.set('fFinishedAt', dateObj.toISOString())
    }
  }
  if (params.fUpdatedAfter) {
    const dateObj =
      params.fUpdatedAfter instanceof Date
        ? params.fUpdatedAfter
        : new Date(params.fUpdatedAfter as Date | string | number)
    queryParams.set('fUpdatedAfter', dateObj.toISOString())
  }
  if (params.fSearch) queryParams.set('fSearch', params.fSearch)
  if (params.sort) queryParams.set('sort', params.sort)

  return useQuery<GetJobsResponse>({
    queryKey: ['jobs', params],
    queryFn: () => apiRequest<GetJobsResponse>(`/jobs?${queryParams.toString()}`),
  })
}

export function useJob(jobId: string | null) {
  const apiRequest = useApiRequest()
  return useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn: () => apiRequest<Job>(`/jobs/${jobId}`),
    enabled: !!jobId,
  })
}

export function useDeleteJob() {
  const apiRequest = useApiRequest()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (jobId: string) => {
      return apiRequest<{ success: boolean; message: string }>(`/jobs/${jobId}`, {
        method: 'DELETE',
      })
    },
    onSuccess: (_, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['job', jobId] })
    },
  })
}

export function useDeleteJobs() {
  const apiRequest = useApiRequest()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: GetJobsParams) => {
      const queryParams = new URLSearchParams()
      // Build query params same as useJobs
      if (params.page) queryParams.set('page', params.page.toString())
      if (params.pageSize) queryParams.set('pageSize', params.pageSize.toString())
      if (params.fStatus) {
        if (Array.isArray(params.fStatus)) {
          for (const status of params.fStatus) {
            queryParams.append('fStatus', status)
          }
        } else {
          queryParams.set('fStatus', params.fStatus)
        }
      }
      if (params.fActionName) {
        if (Array.isArray(params.fActionName)) {
          for (const name of params.fActionName) {
            queryParams.append('fActionName', name)
          }
        } else {
          queryParams.set('fActionName', params.fActionName)
        }
      }
      if (params.fGroupKey) {
        if (Array.isArray(params.fGroupKey)) {
          for (const key of params.fGroupKey) {
            queryParams.append('fGroupKey', key)
          }
        } else {
          queryParams.set('fGroupKey', params.fGroupKey)
        }
      }
      if (params.fOwnerId) {
        if (Array.isArray(params.fOwnerId)) {
          for (const id of params.fOwnerId) {
            queryParams.append('fOwnerId', id)
          }
        } else {
          queryParams.set('fOwnerId', params.fOwnerId)
        }
      }
      if (params.fCreatedAt) {
        if (Array.isArray(params.fCreatedAt)) {
          params.fCreatedAt.forEach((date: Date | string | number) => {
            const dateObj = date instanceof Date ? date : new Date(date)
            queryParams.append('fCreatedAt', dateObj.toISOString())
          })
        } else {
          const dateObj =
            params.fCreatedAt instanceof Date
              ? params.fCreatedAt
              : new Date(params.fCreatedAt as Date | string | number)
          queryParams.set('fCreatedAt', dateObj.toISOString())
        }
      }
      if (params.fStartedAt) {
        if (Array.isArray(params.fStartedAt)) {
          params.fStartedAt.forEach((date: Date | string | number) => {
            const dateObj = date instanceof Date ? date : new Date(date)
            queryParams.append('fStartedAt', dateObj.toISOString())
          })
        } else {
          const dateObj =
            params.fStartedAt instanceof Date
              ? params.fStartedAt
              : new Date(params.fStartedAt as Date | string | number)
          queryParams.set('fStartedAt', dateObj.toISOString())
        }
      }
      if (params.fFinishedAt) {
        if (Array.isArray(params.fFinishedAt)) {
          params.fFinishedAt.forEach((date: Date | string | number) => {
            const dateObj = date instanceof Date ? date : new Date(date)
            queryParams.append('fFinishedAt', dateObj.toISOString())
          })
        } else {
          const dateObj =
            params.fFinishedAt instanceof Date
              ? params.fFinishedAt
              : new Date(params.fFinishedAt as Date | string | number)
          queryParams.set('fFinishedAt', dateObj.toISOString())
        }
      }
      if (params.fUpdatedAfter) {
        const dateObj =
          params.fUpdatedAfter instanceof Date
            ? params.fUpdatedAfter
            : new Date(params.fUpdatedAfter as Date | string | number)
        queryParams.set('fUpdatedAfter', dateObj.toISOString())
      }
      if (params.fSearch) queryParams.set('fSearch', params.fSearch)
      if (params.sort) queryParams.set('sort', params.sort)

      return apiRequest<{ success: boolean; message: string; deletedCount: number }>(
        `/jobs?${queryParams.toString()}`,
        {
          method: 'DELETE',
        },
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}

export function useJobSteps(jobId: string | null, params: GetJobStepsParams = {}) {
  const apiRequest = useApiRequest()
  const queryParams = new URLSearchParams()
  if (params.page) queryParams.set('page', params.page.toString())
  if (params.pageSize) queryParams.set('pageSize', params.pageSize.toString())
  if (params.search) queryParams.set('search', params.search)
  if (params.fUpdatedAfter) {
    const dateObj =
      params.fUpdatedAfter instanceof Date
        ? params.fUpdatedAfter
        : new Date(params.fUpdatedAfter as Date | string | number)
    queryParams.set('fUpdatedAfter', dateObj.toISOString())
  }

  return useQuery<GetJobStepsResponse>({
    queryKey: ['job-steps', jobId, params],
    queryFn: () => apiRequest<GetJobStepsResponse>(`/jobs/${jobId}/steps?${queryParams.toString()}`),
    enabled: !!jobId,
  })
}

export function useStep(stepId: string | null) {
  const apiRequest = useApiRequest()
  return useQuery<JobStep>({
    queryKey: ['step', stepId],
    queryFn: () => apiRequest<JobStep>(`/steps/${stepId}`),
    enabled: !!stepId,
  })
}

export function useCancelJob() {
  const apiRequest = useApiRequest()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (jobId: string) => {
      return apiRequest<{ success: boolean; message: string }>(`/jobs/${jobId}/cancel`, {
        method: 'POST',
      })
    },
    onSuccess: (_, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}

export function useRetryJob() {
  const apiRequest = useApiRequest()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (jobId: string) => {
      return apiRequest<{ success: boolean; message: string; newJobId: string }>(`/jobs/${jobId}/retry`, {
        method: 'POST',
      })
    },
    onSuccess: (_, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}

// Actions API
export function useActions() {
  const apiRequest = useApiRequest()
  return useQuery<GetActionsResult>({
    queryKey: ['actions'],
    queryFn: () => apiRequest<GetActionsResult>('/actions'),
  })
}

export type ActionMetadata = {
  name: string
  mockInput: any
}

export function useActionsMetadata() {
  const apiRequest = useApiRequest()
  return useQuery<ActionMetadata[]>({
    queryKey: ['actions-metadata'],
    queryFn: () => apiRequest<ActionMetadata[]>('/actions/metadata'),
  })
}

export function useRunAction() {
  const apiRequest = useApiRequest()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ actionName, input }: { actionName: string; input: any }) => {
      return apiRequest<{ success: boolean; jobId: string }>(`/actions/${actionName}/run`, {
        method: 'POST',
        body: JSON.stringify(input),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['actions'] })
    },
  })
}

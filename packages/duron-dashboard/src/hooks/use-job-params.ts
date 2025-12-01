import { parseAsArrayOf, parseAsInteger, parseAsJson, parseAsString, useQueryState } from 'nuqs'
import { useMemo } from 'react'
import { z } from 'zod'

import type { JobStatus } from '@/lib/api'

const SortSchema = z.array(
  z.object({
    id: z.enum(['createdAt', 'startedAt', 'finishedAt', 'expiresAt', 'status', 'actionName']),
    desc: z.boolean(),
  }),
)

export function useJobParams(pageSize: number = 10) {
  const [page] = useQueryState('page', parseAsInteger.withDefault(1))
  const [perPage] = useQueryState('perPage', parseAsInteger.withDefault(pageSize))
  const [sortingParam] = useQueryState(
    'sort',
    parseAsJson(SortSchema).withDefault([
      {
        id: 'createdAt',
        desc: true,
      },
    ]),
  )
  const [fActionName] = useQueryState('actionName', parseAsArrayOf(parseAsString).withDefault([]))
  const [statusFilterParam] = useQueryState('status', parseAsArrayOf(parseAsString).withDefault([]))
  const statusFilters = useMemo(() => {
    return statusFilterParam.filter((s): s is JobStatus =>
      ['created', 'active', 'completed', 'failed', 'cancelled'].includes(s),
    )
  }, [statusFilterParam])
  const [createdAtFilterParam] = useQueryState('createdAt', parseAsArrayOf(parseAsInteger).withDefault([]))
  const [startedAtFilterParam] = useQueryState('startedAt', parseAsArrayOf(parseAsInteger).withDefault([]))
  const [finishedAtFilterParam] = useQueryState('finishedAt', parseAsArrayOf(parseAsInteger).withDefault([]))
  const fCreatedAt = useMemo(() => {
    if (createdAtFilterParam.length === 0) return undefined
    return createdAtFilterParam.map((ts) => new Date(ts))
  }, [createdAtFilterParam])
  const fStartedAt = useMemo(() => {
    if (startedAtFilterParam.length === 0) return undefined
    return startedAtFilterParam.map((ts) => new Date(ts))
  }, [startedAtFilterParam])
  const fFinishedAt = useMemo(() => {
    if (finishedAtFilterParam.length === 0) return undefined
    return finishedAtFilterParam.map((ts) => new Date(ts))
  }, [finishedAtFilterParam])
  const [search] = useQueryState('search', parseAsString.withDefault(''))

  const sortString = useMemo(() => {
    if (sortingParam.length === 0) return 'createdAt:desc'
    return sortingParam
      .map((sort) => {
        const order = sort.desc ? 'desc' : 'asc'
        return `${sort.id}:${order}`
      })
      .join(',')
  }, [sortingParam])

  return useMemo(
    () => ({
      params: {
        page,
        pageSize: perPage,
        fStatus: statusFilters.length > 0 ? statusFilters : undefined,
        fActionName: fActionName.length > 0 ? fActionName : undefined,
        fCreatedAt: fCreatedAt,
        fStartedAt: fStartedAt,
        fFinishedAt: fFinishedAt,
        fSearch: search || undefined,
        sort: sortString,
      },
      sort: sortingParam,
    }),
    [page, perPage, statusFilters, fActionName, fCreatedAt, fStartedAt, fFinishedAt, search, sortString, sortingParam],
  )
}

import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs'
import { useCallback, useMemo } from 'react'

export type JobFilter = 'live' | 'archive' | 'all'

export function useJobFilter() {
  const [status, setStatus] = useQueryState('status', parseAsArrayOf(parseAsString).withDefault([]))

  const filter = useMemo((): JobFilter => {
    if (status.length === 2 && status.includes('created') && status.includes('active')) {
      return 'live'
    }
    if (
      status.length === 3 &&
      status.includes('completed') &&
      status.includes('failed') &&
      status.includes('cancelled')
    ) {
      return 'archive'
    }
    if (status.length === 0) {
      return 'all'
    }
    return 'live'
  }, [status])

  const setFilter = useCallback(
    (newFilter: JobFilter) => {
      if (newFilter === 'live') {
        setStatus(['created', 'active'])
      } else if (newFilter === 'archive') {
        setStatus(['completed', 'failed', 'cancelled'])
      } else {
        setStatus(null)
      }
    },
    [setStatus],
  )

  return { filter, setFilter }
}

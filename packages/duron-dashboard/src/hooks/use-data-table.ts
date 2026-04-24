'use client'

import {
  type ColumnFiltersState,
  type ColumnSizingState,
  getCoreRowModel,
  getFacetedMinMaxValues,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type SortingState,
  type TableOptions,
  type TableState,
  type Updater,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  parseAsArrayOf,
  parseAsInteger,
  parseAsString,
  type SingleParser,
  type UseQueryStateOptions,
  useQueryState,
  useQueryStates,
} from 'nuqs'
import * as React from 'react'

import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { getSortingStateParser } from '@/lib/parsers'
import type { ExtendedColumnSort, QueryKeys } from '@/types/data-table'

const PAGE_KEY = 'page'
const PER_PAGE_KEY = 'perPage'
const SORT_KEY = 'sort'
const FILTERS_KEY = 'filters'
const JOIN_OPERATOR_KEY = 'joinOperator'
const ARRAY_SEPARATOR = ','
const DEBOUNCE_MS = 300
const THROTTLE_MS = 50

interface UseDataTableProps<TData>
  extends Omit<
      TableOptions<TData>,
      | 'pageCount'
      | 'getCoreRowModel'
      | 'manualFiltering'
      | 'manualPagination'
      | 'manualSorting'
      | 'onColumnVisibilityChange'
      | 'onColumnSizingChange'
    >,
    Required<Pick<TableOptions<TData>, 'pageCount'>> {
  initialState?: Omit<Partial<TableState>, 'sorting'> & {
    sorting?: ExtendedColumnSort<TData>[]
  }
  queryKeys?: Partial<QueryKeys>
  history?: 'push' | 'replace'
  debounceMs?: number
  throttleMs?: number
  clearOnDefault?: boolean
  enableAdvancedFilter?: boolean
  scroll?: boolean
  shallow?: boolean
  startTransition?: React.TransitionStartFunction
  /** Callback when column visibility changes */
  onColumnVisibilityChange?: (visibility: VisibilityState) => void
  /** Callback when column sizing changes */
  onColumnSizingChange?: (sizing: ColumnSizingState) => void
}

export function useDataTable<TData>(props: UseDataTableProps<TData>) {
  const {
    columns,
    pageCount = -1,
    initialState,
    queryKeys,
    history = 'replace',
    debounceMs = DEBOUNCE_MS,
    throttleMs = THROTTLE_MS,
    clearOnDefault = false,
    enableAdvancedFilter = false,
    scroll = false,
    shallow = true,
    startTransition,
    onColumnVisibilityChange: onColumnVisibilityChangeProp,
    onColumnSizingChange: onColumnSizingChangeProp,
    ...tableProps
  } = props
  const pageKey = queryKeys?.page ?? PAGE_KEY
  const perPageKey = queryKeys?.perPage ?? PER_PAGE_KEY
  const sortKey = queryKeys?.sort ?? SORT_KEY
  const filtersKey = queryKeys?.filters ?? FILTERS_KEY
  const joinOperatorKey = queryKeys?.joinOperator ?? JOIN_OPERATOR_KEY

  const queryStateOptions = React.useMemo<Omit<UseQueryStateOptions<string>, 'parse'>>(
    () => ({
      history,
      scroll,
      shallow,
      throttleMs,
      debounceMs,
      clearOnDefault,
      startTransition,
    }),
    [history, scroll, shallow, throttleMs, debounceMs, clearOnDefault, startTransition],
  )

  const [columnVisibility, setColumnVisibilityState] = React.useState<VisibilityState>(
    initialState?.columnVisibility ?? {},
  )

  const setColumnVisibility = React.useCallback(
    (updaterOrValue: React.SetStateAction<VisibilityState>) => {
      setColumnVisibilityState((prev) => {
        const next = typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue
        // Defer callback to avoid updating parent during render
        queueMicrotask(() => onColumnVisibilityChangeProp?.(next))
        return next
      })
    },
    [onColumnVisibilityChangeProp],
  )

  const [columnSizing, setColumnSizingState] = React.useState<ColumnSizingState>(initialState?.columnSizing ?? {})

  const setColumnSizing = React.useCallback(
    (updaterOrValue: React.SetStateAction<ColumnSizingState>) => {
      setColumnSizingState((prev) => {
        const next = typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue
        // Defer callback to avoid updating parent during render
        queueMicrotask(() => onColumnSizingChangeProp?.(next))
        return next
      })
    },
    [onColumnSizingChangeProp],
  )

  const [page, setPage] = useQueryState(pageKey, parseAsInteger.withOptions(queryStateOptions).withDefault(1))
  const [perPage, setPerPage] = useQueryState(
    perPageKey,
    parseAsInteger.withOptions(queryStateOptions).withDefault(initialState?.pagination?.pageSize ?? 10),
  )

  const pagination: PaginationState = React.useMemo(() => {
    return {
      pageIndex: page - 1, // zero-based index -> one-based index
      pageSize: perPage,
    }
  }, [page, perPage])

  const onPaginationChange = React.useCallback(
    (updaterOrValue: Updater<PaginationState>) => {
      if (typeof updaterOrValue === 'function') {
        const newPagination = updaterOrValue(pagination)
        void setPage(newPagination.pageIndex + 1)
        void setPerPage(newPagination.pageSize)
      } else {
        void setPage(updaterOrValue.pageIndex + 1)
        void setPerPage(updaterOrValue.pageSize)
      }
    },
    [pagination, setPage, setPerPage],
  )

  const columnIds = React.useMemo(() => {
    return new Set(columns.map((column) => column.id).filter(Boolean) as string[])
  }, [columns])

  const [sorting, setSorting] = useQueryState(
    sortKey,
    getSortingStateParser<TData>(columnIds)
      .withOptions(queryStateOptions)
      .withDefault(initialState?.sorting ?? []),
  )

  const onSortingChange = React.useCallback(
    (updaterOrValue: Updater<SortingState>) => {
      if (typeof updaterOrValue === 'function') {
        const newSorting = updaterOrValue(sorting)
        setSorting(newSorting as ExtendedColumnSort<TData>[])
      } else {
        setSorting(updaterOrValue as ExtendedColumnSort<TData>[])
      }
    },
    [sorting, setSorting],
  )

  const filterableColumns = React.useMemo(() => {
    if (enableAdvancedFilter) return []

    return columns.filter((column) => column.enableColumnFilter)
  }, [columns, enableAdvancedFilter])

  const filterParsers = React.useMemo(() => {
    if (enableAdvancedFilter) return {}

    return filterableColumns.reduce<Record<string, SingleParser<string> | SingleParser<string[]>>>((acc, column) => {
      if (column.meta?.options) {
        acc[column.id ?? ''] = parseAsArrayOf(parseAsString, ARRAY_SEPARATOR).withOptions(queryStateOptions)
      } else {
        acc[column.id ?? ''] = parseAsString.withOptions(queryStateOptions)
      }
      return acc
    }, {})
  }, [filterableColumns, queryStateOptions, enableAdvancedFilter])

  const [filterValues, setFilterValues] = useQueryStates(filterParsers)

  const debouncedSetFilterValues = useDebouncedCallback((values: typeof filterValues) => {
    void setPage(1)
    void setFilterValues(values)
  }, debounceMs)

  const initialColumnFilters: ColumnFiltersState = React.useMemo(() => {
    if (enableAdvancedFilter) return []

    return Object.entries(filterValues).reduce<ColumnFiltersState>((filters, [key, value]) => {
      if (value !== null) {
        const processedValue = Array.isArray(value)
          ? value
          : typeof value === 'string' && /[^a-zA-Z0-9]/.test(value)
            ? value.split(/[^a-zA-Z0-9]+/).filter(Boolean)
            : [value]

        filters.push({
          id: key,
          value: processedValue,
        })
      }
      return filters
    }, [])
  }, [filterValues, enableAdvancedFilter])

  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(initialColumnFilters)

  // Watch for external URL changes (e.g. from quick filter toggles)
  const [externalStatusFilter] = useQueryState('status', parseAsArrayOf(parseAsString).withDefault([]))

  React.useEffect(() => {
    if (enableAdvancedFilter) return

    setColumnFilters((prev) => {
      const withoutStatus = prev.filter((f) => f.id !== 'status')

      if (externalStatusFilter.length > 0) {
        return [...withoutStatus, { id: 'status', value: externalStatusFilter }]
      }

      return withoutStatus
    })
  }, [externalStatusFilter, enableAdvancedFilter])

  const onColumnFiltersChange = React.useCallback(
    (updaterOrValue: Updater<ColumnFiltersState>) => {
      if (enableAdvancedFilter) return

      setColumnFilters((prev) => {
        const next = typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue

        const filterUpdates = next.reduce<Record<string, string | string[] | null>>((acc, filter) => {
          if (filterableColumns.find((column) => column.id === filter.id)) {
            acc[filter.id] = filter.value as string | string[]
          }
          return acc
        }, {})

        for (const prevFilter of prev) {
          if (!next.some((filter) => filter.id === prevFilter.id)) {
            filterUpdates[prevFilter.id] = null
          }
        }

        debouncedSetFilterValues(filterUpdates)
        return next
      })
    },
    [debouncedSetFilterValues, filterableColumns, enableAdvancedFilter],
  )

  const table = useReactTable({
    ...tableProps,
    columns,
    initialState,
    pageCount,
    state: {
      pagination,
      sorting,
      columnVisibility,
      columnFilters,
      columnSizing,
      rowSelection: tableProps?.state?.rowSelection ?? {},
    },
    defaultColumn: {
      ...tableProps.defaultColumn,
      enableColumnFilter: false,
    },
    enableRowSelection: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    onRowSelectionChange: tableProps?.onRowSelectionChange,
    onPaginationChange,
    onSortingChange,
    onColumnFiltersChange,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getFacetedMinMaxValues: getFacetedMinMaxValues(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    meta: {
      ...tableProps.meta,
      queryKeys: {
        page: pageKey,
        perPage: perPageKey,
        sort: sortKey,
        filters: filtersKey,
        joinOperator: joinOperatorKey,
      },
    },
  })

  return { table, shallow, debounceMs, throttleMs }
}

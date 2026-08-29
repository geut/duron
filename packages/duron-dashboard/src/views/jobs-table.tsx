'use client'

import type { Column, ColumnDef, OnChangeFn, RowSelectionState } from '@tanstack/react-table'
import { Ban, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { useCallback, useMemo } from 'react'

import { DataTable } from '@/components/data-table/data-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableSortList } from '@/components/data-table/data-table-sort-list'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLayout } from '@/contexts/layout-context'
import { useDataTable } from '@/hooks/use-data-table'
import { useJobParams } from '@/hooks/use-job-params'
import { useJobsPolling } from '@/hooks/use-jobs-polling'
import type { ActionStats, Job, JobStatus } from '@/lib/api'
import { useActions, useJobs } from '@/lib/api'
import { formatExpirationWindow, formatMs } from '@/lib/duration'
import { formatDate } from '@/lib/format'

import { BadgeStatus } from '../components/badge-status'
import { isExpiring } from '../lib/is-expiring'

interface JobsTableProps {
  onJobSelect: (jobId: string | null) => void
  selectedJobId: string | null
}

export function JobsTable({ onJobSelect, selectedJobId }: JobsTableProps) {
  const pageSize = 10

  // Get column visibility and sizing from layout context
  const { config, setJobsTableColumnVisibility, setJobsTableColumnSizing } = useLayout()

  // Enable polling for job updates
  useJobsPolling(true)

  // Fetch actions for actionName filter options
  const { data: actionsData } = useActions()
  const actionNameOptions = useMemo(() => {
    if (!actionsData?.actions) return []
    return actionsData.actions.map((action: ActionStats) => ({
      label: action.name,
      value: action.name,
    }))
  }, [actionsData])

  const columns = useMemo<ColumnDef<Job>[]>(
    () => [
      {
        id: 'ID',
        accessorKey: 'id',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="ID" />
        ),
        cell: ({ cell }) => {
          const fullId = cell.getValue<string>()
          const lastSegment = fullId.split('-').pop() || fullId
          return (
            <Tooltip>
              <TooltipTrigger asChild={true}>
                <div className="font-mono text-xs">{lastSegment}</div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-mono text-xs">{fullId}</p>
              </TooltipContent>
            </Tooltip>
          )
        },
        size: 64,
        enableColumnFilter: false,
      },
      {
        id: 'actionName',
        accessorKey: 'actionName',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Action" />
        ),
        cell: ({ cell }) => <div>{cell.getValue<string>()}</div>,
        meta: {
          label: 'Action',
          placeholder: 'Search actions...',
          variant: 'multiSelect',
          options: actionNameOptions,
        },
        enableColumnFilter: true,
      },
      {
        id: 'description',
        accessorKey: 'description',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Description" />
        ),
        cell: ({ cell }) => {
          const desc = cell.getValue<string | null>()
          if (!desc) return <div className="text-muted-foreground">-</div>
          return (
            <Tooltip>
              <TooltipTrigger asChild={true}>
                <div className="truncate w-full">{desc}</div>
              </TooltipTrigger>
              <TooltipContent className="max-w-[400px]">
                <p className="whitespace-pre-wrap">{desc}</p>
              </TooltipContent>
            </Tooltip>
          )
        },
        size: 200,
        meta: {
          label: 'Description',
          placeholder: 'Search description...',
          variant: 'text',
        },
        enableColumnFilter: true,
        enableSorting: true,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Status" />
        ),
        cell: ({ cell }) => {
          const status = cell.getValue<JobStatus>()
          return <BadgeStatus status={status} />
        },
        meta: {
          label: 'Status',
          variant: 'multiSelect',
          options: [
            { label: 'Created', value: 'created', icon: Clock },
            { label: 'Active', value: 'active', icon: Clock },
            { label: 'Completed', value: 'completed', icon: CheckCircle2 },
            { label: 'Failed', value: 'failed', icon: XCircle },
            { label: 'Cancelled', value: 'cancelled', icon: Ban },
          ],
        },
        size: 64,
        enableColumnFilter: true,
      },
      {
        id: 'startedAt',
        accessorKey: 'startedAt',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Started" />
        ),
        cell: ({ cell }) => {
          const dateStr = cell.getValue<string | null>()
          return <div>{dateStr ? formatDate(dateStr) : '-'}</div>
        },
        size: 64,
        meta: {
          label: 'Started',
          variant: 'dateRange',
        },
        enableColumnFilter: true,
      },
      {
        id: 'finishedAt',
        accessorKey: 'finishedAt',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Completed" />
        ),
        cell: ({ cell }) => {
          const dateStr = cell.getValue<string | null>()
          return <div>{dateStr ? formatDate(dateStr) : '-'}</div>
        },
        size: 64,
        meta: {
          label: 'Completed',
          variant: 'dateRange',
        },
        enableColumnFilter: true,
      },
      {
        id: 'duration',
        accessorKey: 'durationMs',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Duration" />
        ),
        cell: ({ row }) => {
          const { durationMs, startedAt, status } = row.original
          // Only show duration if the job has started
          if (!startedAt) {
            return <div>-</div>
          }

          // For active jobs (no durationMs yet), show "running" indicator
          if (durationMs === null) {
            return (
              <div className="font-mono">
                {status === 'active' && <span className="text-muted-foreground">(running)</span>}
              </div>
            )
          }

          return <div className="font-mono">{formatMs(durationMs)}</div>
        },
        size: 80,
        enableColumnFilter: false,
        enableSorting: true,
      },
      {
        id: 'Expires At',
        accessorKey: 'expiresAt',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Expires At" />
        ),
        cell: ({ cell, row }) => {
          const dateStr = cell.getValue<string | null>()
          if (!dateStr) return <div>-</div>
          return (
            <div
              className={
                isExpiring({
                  isStep: false,
                  expiresAt: new Date(dateStr),
                  status: row.original.status,
                  error: row.original.error,
                })
                  ? 'text-destructive'
                  : ''
              }
            >
              {formatDate(dateStr)} {formatExpirationWindow(row.original.startedAt, dateStr)}
            </div>
          )
        },
        size: 120,
        enableColumnFilter: false,
      },
      {
        id: 'Client ID',
        accessorKey: 'clientId',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Client ID" />
        ),
        cell: ({ cell }) => {
          const clientId = cell.getValue<string | null | undefined>()
          return <div>{clientId || '-'}</div>
        },
        size: 64,
        enableColumnFilter: false,
      },
      {
        id: 'createdAt',
        accessorKey: 'createdAt',
        header: ({ column }: { column: Column<Job, unknown> }) => (
          <DataTableColumnHeader column={column} label="Created" />
        ),
        cell: ({ cell }) => {
          const dateStr = cell.getValue<string>()
          return <div>{formatDate(dateStr)}</div>
        },
        size: 64,
        meta: {
          label: 'Created',
          variant: 'dateRange',
        },
        enableColumnFilter: true,
      },
    ],
    [actionNameOptions],
  )

  const { params, sort } = useJobParams(pageSize)
  const { data } = useJobs(params)

  const handleRowSelectionChange = useCallback<OnChangeFn<RowSelectionState>>(
    (updater) => {
      const newRowSelection =
        typeof updater === 'function'
          ? updater(selectedJobId ? { [selectedJobId]: true } : {})
          : updater
      onJobSelect(Object.keys(newRowSelection)[0] ?? null)
    },
    [onJobSelect, selectedJobId],
  )

  // Create single table with fetched data
  const { table } = useDataTable({
    data: data?.jobs ?? [],
    columns,
    pageCount: data ? Math.ceil(data.total / data.pageSize) : 0,
    enableRowSelection: true,
    enableMultiRowSelection: false,
    initialState: {
      pagination: {
        pageIndex: params.page - 1,
        pageSize: params.pageSize,
      },
      sorting: sort,
      columnVisibility: config.jobsTable.columnVisibility,
      columnSizing: config.jobsTable.columnSizing,
      columnPinning: {
        right: ['select'],
      },
    },
    state: {
      rowSelection: selectedJobId ? { [selectedJobId]: true } : {},
    },
    getRowId: (row) => row.id,
    onRowSelectionChange: handleRowSelectionChange,
    onColumnVisibilityChange: setJobsTableColumnVisibility,
    onColumnSizingChange: setJobsTableColumnSizing,
  })

  return (
    <div className="h-full flex flex-col">
      {/* Header with title and toolbar */}
      <div className="px-4 min-h-12 border-b shrink-0 flex items-center justify-between gap-2">
        <h2 className="font-medium shrink-0">Jobs</h2>
        <DataTableToolbar table={table} className="flex-1 justify-end">
          <DataTableSortList table={table} />
        </DataTableToolbar>
      </div>

      {/* Table content */}
      <div className="flex-1 overflow-hidden">
        <DataTable table={table} fillHeight={true} />
      </div>
    </div>
  )
}

'use client'

import type { Column, ColumnDef, OnChangeFn, RowSelectionState } from '@tanstack/react-table'
import { Ban, CheckCircle2, ChevronDownIcon, ChevronRightIcon, Clock, XCircle } from 'lucide-react'
import { useCallback, useMemo } from 'react'

import { DataTable } from '@/components/data-table/data-table'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { DataTableSortList } from '@/components/data-table/data-table-sort-list'
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDataTable } from '@/hooks/use-data-table'
import { useJobParams } from '@/hooks/use-job-params'
import { useJobsPolling } from '@/hooks/use-jobs-polling'
import type { ActionStats, Job, JobStatus } from '@/lib/api'
import { useActions, useJobs } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { BadgeStatus } from '../components/badge-status'
import { isExpiring } from '../lib/is-expiring'

interface JobsTableProps {
  onJobSelect: (jobId: string | null) => void
  selectedJobId: string | null
}

export function JobsTable({ onJobSelect, selectedJobId }: JobsTableProps) {
  const pageSize = 10

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
        id: 'select',
        cell: ({ row }) => (
          // show a chevron right icon if the row is selected and a chevron down icon if the row is not selected
          <Button variant="ghost" size="icon" onClick={() => row.toggleSelected(!row.getIsSelected())}>
            {row.getIsSelected() ? <ChevronRightIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
          </Button>
        ),
        size: 32,
        enableSorting: false,
        enableHiding: false,
      },
      {
        id: 'ID',
        accessorKey: 'id',
        header: ({ column }: { column: Column<Job, unknown> }) => <DataTableColumnHeader column={column} label="ID" />,
        cell: ({ cell }) => {
          const fullId = cell.getValue<string>()
          const lastSegment = fullId.split('-').pop() || fullId
          return (
            <Tooltip>
              <TooltipTrigger asChild={true}>
                <div className="font-mono text-xs cursor-help">{lastSegment}</div>
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
              {formatDate(dateStr)}
            </div>
          )
        },
        size: 64,
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
          return <div className="font-mono text-xs">{clientId || '-'}</div>
        },
        size: 64,
        enableColumnFilter: false,
      },
    ],
    [actionNameOptions],
  )

  const { params, sort } = useJobParams(pageSize)
  const { data } = useJobs(params)

  const handleRowSelectionChange = useCallback<OnChangeFn<RowSelectionState>>(
    (updater) => {
      const newRowSelection =
        typeof updater === 'function' ? updater(selectedJobId ? { [selectedJobId]: true } : {}) : updater
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
      columnVisibility: {
        clientId: false,
      },
    },
    state: {
      rowSelection: selectedJobId ? { [selectedJobId]: true } : {},
    },
    getRowId: (row) => row.id,
    onRowSelectionChange: handleRowSelectionChange,
  })

  return (
    <div className="h-full flex flex-col">
      <ScrollArea className="h-full w-full [&_[data-radix-scroll-area-viewport]>:first-child]:block!">
        <div className="flex-1 p-4">
          <DataTable table={table}>
            <DataTableToolbar table={table}>
              <DataTableSortList table={table} />
            </DataTableToolbar>
          </DataTable>
        </div>
      </ScrollArea>
    </div>
  )
}

'use client'

import type { Column, Table } from '@tanstack/react-table'
import { Check, Filter, MoreVertical, X } from 'lucide-react'
import * as React from 'react'

import { DataTableDateFilter } from '@/components/data-table/data-table-date-filter'
import { DataTableFacetedFilter } from '@/components/data-table/data-table-faceted-filter'
import { DataTableSliderFilter } from '@/components/data-table/data-table-slider-filter'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface DataTableToolbarProps<TData> extends React.ComponentProps<'div'> {
  table: Table<TData>
}

export function DataTableToolbar<TData>({ table, children, className, ...props }: DataTableToolbarProps<TData>) {
  const isFiltered = table.getState().columnFilters.length > 0
  const [filtersModalOpen, setFiltersModalOpen] = React.useState(false)
  const [optionsModalOpen, setOptionsModalOpen] = React.useState(false)

  const columns = table.getAllColumns().filter((column) => column.getCanFilter())

  const onReset = React.useCallback(() => {
    table.resetColumnFilters()
  }, [table])

  const filtersContent = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {columns.map((column) => (
          <DataTableToolbarFilter key={column.id} column={column} />
        ))}
      </div>
      {isFiltered && (
        <Button aria-label="Reset filters" variant="outline" size="sm" className="border-dashed" onClick={onReset}>
          <X className="mr-2 h-4 w-4" />
          Reset Filters
        </Button>
      )}
    </div>
  )

  const columnsForVisibility = React.useMemo(
    () => table.getAllColumns().filter((column) => typeof column.accessorFn !== 'undefined' && column.getCanHide()),
    [table],
  )

  const optionsContent = (
    <div className="flex flex-col gap-4">
      {children && <div className="flex flex-col gap-2">{children}</div>}
      {columnsForVisibility.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Column Visibility</h3>
          <Command>
            <CommandInput placeholder="Search columns..." />
            <CommandList>
              <CommandEmpty>No columns found.</CommandEmpty>
              <CommandGroup>
                {columnsForVisibility.map((column) => (
                  <CommandItem key={column.id} onSelect={() => column.toggleVisibility(!column.getIsVisible())}>
                    <span className="truncate">{column.columnDef.meta?.label ?? column.id}</span>
                    <Check
                      className={cn('ml-auto size-4 shrink-0', column.getIsVisible() ? 'opacity-100' : 'opacity-0')}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )

  return (
    <>
      <div
        role="toolbar"
        aria-orientation="horizontal"
        className={cn('flex w-full items-center justify-between gap-2 p-1', className)}
        {...props}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFiltersModalOpen(true)}
          className="flex items-center gap-2"
        >
          <Filter className="h-4 w-4" />
          Filters
          {isFiltered && (
            <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
              {table.getState().columnFilters.length}
            </span>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOptionsModalOpen(true)}
          className="flex items-center gap-2"
        >
          <MoreVertical className="h-4 w-4" />
          Options
        </Button>
      </div>

      {/* Filters Modal */}
      <Dialog open={filtersModalOpen} onOpenChange={setFiltersModalOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] flex flex-col">
          <DialogTitle>Filters</DialogTitle>
          <div className="flex-1 overflow-auto min-h-0">{filtersContent}</div>
        </DialogContent>
      </Dialog>

      {/* Options Modal */}
      <Dialog open={optionsModalOpen} onOpenChange={setOptionsModalOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] flex flex-col">
          <DialogTitle>Options</DialogTitle>
          <div className="flex-1 overflow-auto min-h-0">{optionsContent}</div>
        </DialogContent>
      </Dialog>
    </>
  )
}
interface DataTableToolbarFilterProps<TData> {
  column: Column<TData>
}

function DataTableToolbarFilter<TData>({ column }: DataTableToolbarFilterProps<TData>) {
  {
    const columnMeta = column.columnDef.meta

    const onFilterRender = React.useCallback(() => {
      if (!columnMeta?.variant) return null

      switch (columnMeta.variant) {
        case 'text':
          return (
            <Input
              placeholder={columnMeta.placeholder ?? columnMeta.label}
              value={(column.getFilterValue() as string) ?? ''}
              onChange={(event) => column.setFilterValue(event.target.value)}
              className="h-8 w-40 lg:w-56"
            />
          )

        case 'number':
          return (
            <div className="relative">
              <Input
                type="number"
                inputMode="numeric"
                placeholder={columnMeta.placeholder ?? columnMeta.label}
                value={(column.getFilterValue() as string) ?? ''}
                onChange={(event) => column.setFilterValue(event.target.value)}
                className={cn('h-8 w-[120px]', columnMeta.unit && 'pr-8')}
              />
              {columnMeta.unit && (
                <span className="absolute top-0 right-0 bottom-0 flex items-center rounded-r-md bg-accent px-2 text-muted-foreground text-sm">
                  {columnMeta.unit}
                </span>
              )}
            </div>
          )

        case 'range':
          return <DataTableSliderFilter column={column} title={columnMeta.label ?? column.id} />

        case 'date':
        case 'dateRange':
          return (
            <DataTableDateFilter
              column={column}
              title={columnMeta.label ?? column.id}
              multiple={columnMeta.variant === 'dateRange'}
            />
          )

        case 'select':
        case 'multiSelect':
          return (
            <DataTableFacetedFilter
              column={column}
              title={columnMeta.label ?? column.id}
              options={columnMeta.options ?? []}
              multiple={columnMeta.variant === 'multiSelect'}
            />
          )

        default:
          return null
      }
    }, [column, columnMeta])

    return onFilterRender()
  }
}

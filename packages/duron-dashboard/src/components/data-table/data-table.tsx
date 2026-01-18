import { flexRender, type Table as TanstackTable } from '@tanstack/react-table'
import type * as React from 'react'

import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getCommonPinningStyles } from '@/lib/data-table.ts'
import { cn } from '@/lib/utils'

interface DataTableProps<TData> extends React.ComponentProps<'div'> {
  table: TanstackTable<TData>
  actionBar?: React.ReactNode
  /**
   * When true, the table will expand to fill available height with:
   * - Fixed header
   * - Scrollable body
   * - Fixed pagination footer
   */
  fillHeight?: boolean
}

export function DataTable<TData>({
  table,
  actionBar,
  children,
  className,
  fillHeight = false,
  ...props
}: DataTableProps<TData>) {
  if (fillHeight) {
    return (
      <div className={cn('flex h-full w-full flex-col', className)} {...props}>
        {/* Toolbar passed as children */}
        {children && <div className="shrink-0">{children}</div>}

        {/* Scrollable table container */}
        <div className="flex-1 overflow-hidden border-y">
          <ScrollArea className="h-full">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        style={{
                          ...getCommonPinningStyles({ column: header.column }),
                        }}
                      >
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => {
                    const isSelected = row.getIsSelected()
                    return (
                      <TableRow key={row.id} data-state={isSelected ? 'selected' : undefined}>
                        {row.getVisibleCells().map((cell) => (
                          <TableCell
                            key={cell.id}
                            style={{
                              ...getCommonPinningStyles({ column: cell.column }),
                            }}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={table.getAllColumns().length} className="h-24 text-center">
                      No results.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <ScrollBar orientation="horizontal" className="w-full" />
          </ScrollArea>
        </div>

        {/* Fixed pagination footer */}
        <div className="shrink-0 border-t-0 bg-background pt-2 pb-2">
          <DataTablePagination table={table} />
          {actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar}
        </div>
      </div>
    )
  }

  // Original layout (non-fillHeight)
  return (
    <div className={cn('flex w-full flex-col gap-2.5', className)} {...props}>
      {children}
      <ScrollArea className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    style={{
                      ...getCommonPinningStyles({ column: header.column }),
                    }}
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => {
                const isSelected = row.getIsSelected()
                return (
                  <TableRow key={row.id} data-state={isSelected ? 'selected' : undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        style={{
                          ...getCommonPinningStyles({ column: cell.column }),
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <ScrollBar orientation="horizontal" className="w-full" />
      </ScrollArea>

      <div className="flex flex-col gap-2.5">
        <DataTablePagination table={table} />
        {actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar}
      </div>
    </div>
  )
}

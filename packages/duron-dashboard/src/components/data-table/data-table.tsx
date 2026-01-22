import { flexRender, type Header, type Table as TanstackTable } from '@tanstack/react-table'
import type * as React from 'react'

import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

function ColumnResizer<TData>({ header }: { header: Header<TData, unknown> }) {
  if (!header.column.getCanResize()) {
    return null
  }

  return (
    <button
      type="button"
      aria-label={`Resize column ${header.column.id}`}
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
      onDoubleClick={() => header.column.resetSize()}
      className={cn(
        'absolute top-0 -right-0.5 h-full w-1 cursor-col-resize select-none touch-none p-0 border-0',
        'bg-transparent hover:bg-primary/50 transition-colors focus:bg-primary/50 focus:outline-none',
        // Show a thin visible line in the center
        'after:absolute after:top-0 after:left-1/2 after:-translate-x-1/2 after:h-full after:w-px after:bg-border',
        header.column.getIsResizing() && 'bg-primary/50 after:bg-primary',
      )}
    />
  )
}

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
          <ScrollArea className="h-full whitespace-nowrap">
            <div className="min-w-max">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => {
                        const isPinned = header.column.getIsPinned()
                        return (
                          <TableHead
                            key={header.id}
                            colSpan={header.colSpan}
                            className={cn(
                              'relative',
                              isPinned === 'right' &&
                                'sticky right-0 z-20 bg-background shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.1)]',
                              isPinned === 'left' && 'sticky left-0 z-20 bg-background',
                            )}
                            style={{ width: header.getSize() }}
                          >
                            {header.isPlaceholder
                              ? null
                              : flexRender(header.column.columnDef.header, header.getContext())}
                            <ColumnResizer header={header} />
                          </TableHead>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => {
                      const isSelected = row.getIsSelected()
                      return (
                        <TableRow
                          key={row.id}
                          data-state={isSelected ? 'selected' : undefined}
                          className="cursor-pointer"
                          onClick={() => row.toggleSelected()}
                        >
                          {row.getVisibleCells().map((cell) => {
                            const isPinned = cell.column.getIsPinned()
                            return (
                              <TableCell
                                key={cell.id}
                                className={cn(
                                  'overflow-hidden',
                                  isPinned === 'right' && [
                                    'sticky right-0 shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.1)]',
                                    isSelected ? 'bg-primary/10' : 'bg-background',
                                  ],
                                  isPinned === 'left' && [
                                    'sticky left-0',
                                    isSelected ? 'bg-primary/10' : 'bg-background',
                                  ],
                                )}
                                style={{
                                  width: cell.column.getSize(),
                                  maxWidth: cell.column.getSize(),
                                }}
                              >
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </TableCell>
                            )
                          })}
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
            </div>
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
      <ScrollArea className="rounded-md border whitespace-nowrap">
        <div className="min-w-max">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const isPinned = header.column.getIsPinned()
                    return (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        className={cn(
                          'relative',
                          isPinned === 'right' &&
                            'sticky right-0 z-20 bg-background shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.1)]',
                          isPinned === 'left' && 'sticky left-0 z-20 bg-background',
                        )}
                        style={{ width: header.getSize() }}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                        <ColumnResizer header={header} />
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row) => {
                  const isSelected = row.getIsSelected()
                  return (
                    <TableRow
                      key={row.id}
                      data-state={isSelected ? 'selected' : undefined}
                      className="cursor-pointer"
                      onClick={() => row.toggleSelected()}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isPinned = cell.column.getIsPinned()
                        return (
                          <TableCell
                            key={cell.id}
                            className={cn(
                              'overflow-hidden',
                              isPinned === 'right' && [
                                'sticky right-0 shadow-[-4px_0_8px_-4px_rgba(0,0,0,0.1)]',
                                isSelected ? 'bg-primary/10' : 'bg-background',
                              ],
                              isPinned === 'left' && [
                                'sticky left-0',
                                isSelected ? 'bg-primary/10' : 'bg-background',
                              ],
                            )}
                            style={{
                              width: cell.column.getSize(),
                              maxWidth: cell.column.getSize(),
                            }}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        )
                      })}
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
        </div>
        <ScrollBar orientation="horizontal" className="w-full" />
      </ScrollArea>

      <div className="flex flex-col gap-2.5">
        <DataTablePagination table={table} />
        {actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar}
      </div>
    </div>
  )
}

'use client'

import { Archive, Clock, Database, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useArchiveStats, usePruneArchive, useTruncateArchive } from '@/lib/api'

export function ArchivePage() {
  const { data: stats, isLoading } = useArchiveStats()
  const pruneMutation = usePruneArchive()
  const truncateMutation = useTruncateArchive()

  const handlePrune = async () => {
    const olderThan = prompt('Prune jobs older than (e.g. "7d", "1h", "30m"):', '7d')
    if (!olderThan) return

    try {
      const result = await pruneMutation.mutateAsync({ olderThan })
      alert(`Pruned ${result.deletedJobs} job(s)`)
    } catch (error: any) {
      alert(error?.message || 'Failed to prune archive')
    }
  }

  const handleTruncate = async () => {
    if (
      !confirm(
        'WARNING: This will permanently delete ALL archived jobs, steps, and spans. This action cannot be undone.\n\nAre you sure?',
      )
    ) {
      return
    }

    try {
      await truncateMutation.mutateAsync()
      alert('Archive truncated successfully')
    } catch (error: any) {
      alert(error?.message || 'Failed to truncate archive')
    }
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Archive className="h-6 w-6" />
              Archive Management
            </h1>
            <p className="text-muted-foreground mt-1">Manage archived jobs, steps, and spans</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handlePrune} disabled={pruneMutation.isPending}>
              <Clock className="h-4 w-4 mr-2" />
              Prune Old Jobs
            </Button>
            <Button variant="destructive" onClick={handleTruncate} disabled={truncateMutation.isPending}>
              <Trash2 className="h-4 w-4 mr-2" />
              Truncate All
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="text-muted-foreground">Loading stats...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Archived Jobs</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.jobsCount ?? 0}</div>
                <CardDescription>Total jobs in archive</CardDescription>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Archived Steps</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.stepsCount ?? 0}</div>
                <CardDescription>Total steps in archive</CardDescription>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Archived Spans</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.spansCount ?? 0}</div>
                <CardDescription>Total spans in archive</CardDescription>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Oldest Job</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats?.oldestJobDate ? new Date(stats.oldestJobDate).toLocaleDateString() : '—'}
                </div>
                <CardDescription>Date of oldest archived job</CardDescription>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Last Pruned</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats?.lastPrunedAt ? new Date(stats.lastPrunedAt).toLocaleDateString() : '—'}
                </div>
                <CardDescription>When archive was last pruned</CardDescription>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}

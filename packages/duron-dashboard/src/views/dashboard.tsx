'use client'

import { LogOut, MoreVertical, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { CreateJobDialog } from '@/components/create-job-dialog'
import { JobSearch } from '@/components/job-search'
import { Logo } from '@/components/logo'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/contexts/auth-context'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useJobParams } from '@/hooks/use-job-params'
import { useDeleteJobs } from '@/lib/api'
import { JobDetails } from './job-details'
import { JobsTable } from './jobs-table'
import { StepList } from './step-list'

interface DashboardProps {
  showLogo?: boolean
  enableLogin?: boolean
}

export function Dashboard({ showLogo = true, enableLogin = true }: DashboardProps) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [createJobDialogOpen, setCreateJobDialogOpen] = useState(false)
  const [jobDetailsVisible, setJobDetailsVisible] = useState(false)
  const isMobile = useIsMobile()
  const { logout } = useAuth()

  const handleJobSelect = useCallback((jobId: string | null) => {
    setSelectedJobId(jobId)
  }, [])

  useEffect(() => {
    if (!jobDetailsVisible) {
      handleJobSelect(null)
    }
  }, [jobDetailsVisible, handleJobSelect])

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedStepId(null)
    }
    setJobDetailsVisible(!!selectedJobId)
  }, [selectedJobId])

  const handleJobCreated = useCallback((jobId: string) => {
    setSelectedJobId(jobId)
  }, [])

  const { params } = useJobParams()
  const deleteJobsMutation = useDeleteJobs()

  const handleDeleteFilteredJobs = useCallback(async () => {
    if (
      confirm(
        'Are you sure you want to delete all jobs matching the current filters? Active jobs will be excluded. This action cannot be undone.',
      )
    ) {
      try {
        const result = await deleteJobsMutation.mutateAsync(params)
        alert(`Successfully deleted ${result.deletedCount} job(s)`)
      } catch (error: any) {
        alert(error?.message || 'Failed to delete jobs')
      }
    }
  }, [params, deleteJobsMutation])

  return (
    <div className="h-screen flex flex-col">
      <header className="border-b p-2 flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-4">
        <div className="flex items-center justify-between w-full sm:w-auto">
          {showLogo && <Logo className="h-8 sm:h-10" />}
          <div className="flex items-center gap-2 sm:hidden">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild={true}>
                <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                  <MoreVertical className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCreateJobDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Job
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleDeleteFilteredJobs}
                  disabled={deleteJobsMutation.isPending}
                  variant="destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Jobs
                </DropdownMenuItem>
                {enableLogin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={logout}>
                      <LogOut className="h-4 w-4 mr-2" />
                      Logout
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="w-full sm:flex-1 sm:flex sm:justify-center order-3 sm:order-2">
          <JobSearch className="w-full sm:w-full sm:max-w-2xl" />
        </div>
        <div className="hidden sm:flex items-center gap-2 order-2 sm:order-3">
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild={true}>
              <Button variant="outline" size="sm">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setCreateJobDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Job
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleDeleteFilteredJobs}
                disabled={deleteJobsMutation.isPending}
                variant="destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Jobs
              </DropdownMenuItem>
              {enableLogin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout}>
                    <LogOut className="h-4 w-4 mr-2" />
                    Logout
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Desktop Layout: Top row (Jobs | Details), Bottom row (Steps) */}
        {!isMobile && (
          <div className="flex-1 flex flex-col h-full min-w-0">
            {/* Top Row: Jobs and Job Details */}
            <div
              className={`flex flex-row border-b transition-all duration-200 ${selectedJobId ? 'h-1/2' : 'flex-1'} min-w-0`}
            >
              {/* Jobs Section */}
              <div
                className={`${
                  jobDetailsVisible ? 'w-1/2' : 'w-full'
                } border-r flex flex-col overflow-hidden transition-all duration-200 min-w-0`}
              >
                <JobsTable onJobSelect={handleJobSelect} selectedJobId={selectedJobId} />
              </div>

              {/* Job Details Section */}
              {jobDetailsVisible && (
                <div className="w-1/2 flex flex-col overflow-hidden transition-all duration-200 min-w-0">
                  <JobDetails jobId={selectedJobId} onClose={() => setJobDetailsVisible(false)} />
                </div>
              )}
            </div>

            {/* Bottom Row: Steps (full width) */}
            {selectedJobId && (
              <div className="h-1/2 flex flex-col overflow-hidden min-w-0">
                <div className="px-4 min-h-12 border-b shrink-0 flex items-center justify-between">
                  <h2 className="font-medium">Steps</h2>
                </div>
                <div className="flex-1 overflow-hidden">
                  <StepList jobId={selectedJobId} selectedStepId={selectedStepId} onStepSelect={setSelectedStepId} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Mobile: Vertical Layout - Jobs, Job Details, and Steps */}
        {isMobile && (
          <div className="flex-1 flex flex-col h-full">
            {/* Jobs Section */}
            <div className={`${selectedJobId ? 'h-1/3' : 'h-full'} border-b flex flex-col overflow-hidden`}>
              <JobsTable onJobSelect={handleJobSelect} selectedJobId={selectedJobId} />
            </div>

            {/* Job Details Section */}
            {selectedJobId && (
              <div className="h-1/3 border-b flex flex-col overflow-hidden">
                <JobDetails jobId={selectedJobId} />
              </div>
            )}

            {/* Steps Section */}
            {selectedJobId && (
              <div className="h-1/3 flex flex-col overflow-hidden">
                <div className="px-4 min-h-12 border-b shrink-0 flex items-center">
                  <h2 className="font-medium">Steps</h2>
                </div>
                <div className="flex-1 overflow-hidden">
                  <StepList jobId={selectedJobId} selectedStepId={selectedStepId} onStepSelect={setSelectedStepId} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <CreateJobDialog
        open={createJobDialogOpen}
        onOpenChange={setCreateJobDialogOpen}
        onJobCreated={handleJobCreated}
      />
    </div>
  )
}

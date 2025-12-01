'use client'

import { ChevronLeft, LogOut, MoreVertical, Plus, Trash2, X } from 'lucide-react'
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
  const [stepListFullScreenVisible, setStepListFullScreenVisible] = useState(false)
  const [createJobDialogOpen, setCreateJobDialogOpen] = useState(false)
  const [jobDetailsVisible, setJobDetailsVisible] = useState(false)
  const [stepListVisible, setStepListVisible] = useState(false)
  const isMobile = useIsMobile()
  const { logout } = useAuth()

  const handleJobSelect = useCallback((jobId: string | null) => {
    setSelectedJobId(jobId)
  }, [])

  useEffect(() => {
    if (!jobDetailsVisible && !stepListVisible) {
      handleJobSelect(null)
    }
  }, [jobDetailsVisible, stepListVisible, handleJobSelect])

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedStepId(null)
    }

    if (isMobile) {
      setJobDetailsVisible(!!selectedJobId)
    } else {
      setJobDetailsVisible(!!selectedJobId)
      setStepListVisible(!!selectedJobId)
    }
  }, [selectedJobId, isMobile])

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
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Desktop: Three Horizontal Views with Collapse */}
        {!isMobile && (
          <div className="flex-1 flex flex-row h-full min-w-0">
            {/* Jobs Section */}
            <div
              className={`${
                !jobDetailsVisible && !stepListVisible
                  ? 'w-full'
                  : !jobDetailsVisible || !stepListVisible
                    ? 'w-1/2'
                    : 'flex-1'
              } border-r flex flex-col overflow-hidden transition-all duration-200 min-w-0`}
            >
              <div className="p-2 border-b shrink-0 flex items-center justify-between">
                <h2 className="font-medium">Jobs</h2>
              </div>
              <div className="flex-1 overflow-hidden">
                <JobsTable onJobSelect={handleJobSelect} selectedJobId={selectedJobId} />
              </div>
            </div>

            {/* Job Details Section */}
            {jobDetailsVisible && (
              <div
                className={`${
                  stepListVisible ? 'flex-1' : 'w-1/2'
                } border-r flex flex-col overflow-hidden transition-all duration-200 min-w-0`}
              >
                <div className="p-2 border-b shrink-0 flex items-center justify-between">
                  <h2 className="font-medium">Job Details</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setJobDetailsVisible(false)}
                    className="h-6 w-6 p-0"
                    title="Hide Job Details"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <JobDetails jobId={selectedJobId} onOpenStepList={() => setStepListFullScreenVisible(true)} />
                </div>
              </div>
            )}

            {/* Step List Section */}
            {stepListVisible && (
              <div
                className={`${
                  jobDetailsVisible ? 'flex-1' : 'w-1/2'
                } flex flex-col overflow-hidden transition-all duration-200 min-w-0`}
              >
                <div className="p-2 border-b shrink-0 flex items-center justify-between">
                  <h2 className="font-medium">Steps</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStepListVisible(false)}
                    className="h-6 w-6 p-0"
                    title="Hide Steps"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <StepList jobId={selectedJobId} selectedStepId={selectedStepId} onStepSelect={setSelectedStepId} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Mobile: Vertical Layout - Jobs and Job Details 50% each */}
        {isMobile && (
          <>
            <div className="flex-1 flex flex-col h-full">
              {/* Jobs Section */}
              <div className={`${selectedJobId ? 'h-1/2' : 'h-full'} border-b flex flex-col overflow-hidden`}>
                <div className="p-2 border-b shrink-0">
                  <h2 className="font-medium">Jobs</h2>
                </div>
                <div className="flex-1 overflow-hidden">
                  <JobsTable onJobSelect={handleJobSelect} selectedJobId={selectedJobId} />
                </div>
              </div>

              {/* Job Details Section */}
              {selectedJobId && (
                <div className="h-1/2 flex flex-col overflow-hidden">
                  <div className="p-2 border-b shrink-0">
                    <h2 className="font-medium">Job Details</h2>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <JobDetails jobId={selectedJobId} onOpenStepList={() => setStepListFullScreenVisible(true)} />
                  </div>
                </div>
              )}
            </div>

            {/* Step List Overlay - Mobile */}
            {stepListFullScreenVisible && (
              <div className="absolute inset-0 z-50 bg-background flex flex-col">
                <div className="p-2 border-b flex items-center justify-between shrink-0">
                  <h2 className="font-medium">Steps</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setStepListFullScreenVisible(false)
                      setSelectedStepId(null)
                    }}
                    className="h-6 w-6 p-0"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <StepList jobId={selectedJobId} selectedStepId={selectedStepId} onStepSelect={setSelectedStepId} />
                </div>
              </div>
            )}
          </>
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

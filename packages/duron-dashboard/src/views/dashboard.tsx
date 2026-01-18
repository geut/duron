'use client'

import { LogOut, MoreVertical, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

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
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAuth } from '@/contexts/auth-context'
import { useLayout } from '@/contexts/layout-context'
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
  const { config, setDesktopHorizontalSizes, setDesktopVerticalSizes, setMobileVerticalSizes } = useLayout()

  const handleJobSelect = useCallback((jobId: string | null) => {
    setSelectedJobId(jobId)
  }, [])

  // Desktop layout config (horizontal: [details, steps] in bottom row)
  const desktopHorizontalLayout = useMemo(() => {
    const details = config.desktop?.horizontalSizes?.[0] ?? 30
    const steps = config.desktop?.horizontalSizes?.[1] ?? 70
    return { details, steps }
  }, [config.desktop?.horizontalSizes])

  // Desktop layout config (vertical: [jobs, bottom] where bottom has details|steps)
  const desktopVerticalLayout = useMemo(() => {
    const jobs = config.desktop?.verticalSizes?.[0] ?? 50
    const bottom = config.desktop?.verticalSizes?.[1] ?? 50
    return { jobs, bottom }
  }, [config.desktop?.verticalSizes])

  // Mobile layout config
  const mobileLayout = useMemo(() => {
    const jobs = config.mobile?.verticalSizes?.[0] ?? 33
    const details = config.mobile?.verticalSizes?.[1] ?? 33
    const steps = config.mobile?.verticalSizes?.[2] ?? 34
    return { jobs, details, steps }
  }, [config.mobile?.verticalSizes])

  // Handle desktop horizontal panel resize (details/steps in bottom row)
  const handleDesktopHorizontalLayoutChange = useCallback(
    (layout: { [panelId: string]: number }) => {
      if (!('details-panel' in layout) || !('steps-panel' in layout)) {
        return
      }
      const details = layout['details-panel'] ?? 30
      const steps = layout['steps-panel'] ?? 70
      setDesktopHorizontalSizes([details, steps])
    },
    [setDesktopHorizontalSizes],
  )

  // Handle desktop vertical panel resize (jobs/bottom)
  const handleDesktopVerticalLayoutChange = useCallback(
    (layout: { [panelId: string]: number }) => {
      if (!('jobs-panel' in layout) || !('bottom-panel' in layout)) {
        return
      }
      const jobs = layout['jobs-panel'] ?? 50
      const bottom = layout['bottom-panel'] ?? 50
      setDesktopVerticalSizes([jobs, bottom])
    },
    [setDesktopVerticalSizes],
  )

  // Handle mobile vertical panel resize (jobs/details/steps)
  const handleMobileVerticalLayoutChange = useCallback(
    (layout: { [panelId: string]: number }) => {
      if (
        !('mobile-jobs-panel' in layout) ||
        !('mobile-details-panel' in layout) ||
        !('mobile-steps-panel' in layout)
      ) {
        return
      }
      const jobs = layout['mobile-jobs-panel'] ?? 33
      const details = layout['mobile-details-panel'] ?? 33
      const steps = layout['mobile-steps-panel'] ?? 34
      setMobileVerticalSizes([jobs, details, steps])
    },
    [setMobileVerticalSizes],
  )

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
      <div className="flex-1 overflow-hidden">
        {/* Desktop Layout with Resizable Panels */}
        {/* Layout: [Jobs Table (top)] / [Job Details | Steps (bottom)] */}
        {!isMobile && (
          <ResizablePanelGroup
            direction="vertical"
            className="h-full"
            defaultLayout={{
              'jobs-panel': desktopVerticalLayout.jobs,
              'bottom-panel': desktopVerticalLayout.bottom,
            }}
            onLayoutChanged={handleDesktopVerticalLayoutChange}
          >
            {/* Top Row: Jobs Table (full width) */}
            <ResizablePanel id="jobs-panel" defaultSize={selectedJobId ? desktopVerticalLayout.jobs : 100} minSize={20}>
              <div className="h-full">
                <JobsTable onJobSelect={handleJobSelect} selectedJobId={selectedJobId} />
              </div>
            </ResizablePanel>

            {/* Bottom Row: Job Details | Steps */}
            {selectedJobId && (
              <ResizablePanel id="bottom-panel" defaultSize={desktopVerticalLayout.bottom} minSize={15}>
                <ResizablePanelGroup
                  direction="horizontal"
                  className="h-full border-t-2"
                  defaultLayout={{
                    'details-panel': desktopHorizontalLayout.details,
                    'steps-panel': desktopHorizontalLayout.steps,
                  }}
                  onLayoutChanged={handleDesktopHorizontalLayoutChange}
                >
                  {/* Job Details Section */}
                  {jobDetailsVisible && (
                    <ResizablePanel id="details-panel" defaultSize={desktopHorizontalLayout.details} minSize={15}>
                      <div className="h-full border-r-2">
                        <JobDetails jobId={selectedJobId} onClose={() => setJobDetailsVisible(false)} />
                      </div>
                    </ResizablePanel>
                  )}

                  {/* Steps Section */}
                  <ResizablePanel
                    id="steps-panel"
                    defaultSize={jobDetailsVisible ? desktopHorizontalLayout.steps : 100}
                    minSize={20}
                  >
                    <div className="h-full flex flex-col overflow-hidden">
                      <div className="px-4 min-h-12 border-b shrink-0 flex items-center justify-between">
                        <h2 className="font-medium">Steps</h2>
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <StepList
                          jobId={selectedJobId}
                          selectedStepId={selectedStepId}
                          onStepSelect={setSelectedStepId}
                        />
                      </div>
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
        )}

        {/* Mobile: Vertical Resizable Layout */}
        {isMobile && (
          <ResizablePanelGroup
            direction="vertical"
            className="h-full"
            defaultLayout={{
              'mobile-jobs-panel': mobileLayout.jobs,
              'mobile-details-panel': mobileLayout.details,
              'mobile-steps-panel': mobileLayout.steps,
            }}
            onLayoutChanged={handleMobileVerticalLayoutChange}
          >
            {/* Jobs Section */}
            <ResizablePanel id="mobile-jobs-panel" defaultSize={selectedJobId ? mobileLayout.jobs : 100} minSize={15}>
              <JobsTable onJobSelect={handleJobSelect} selectedJobId={selectedJobId} />
            </ResizablePanel>

            {/* Job Details Section */}
            {selectedJobId && (
              <ResizablePanel
                id="mobile-details-panel"
                defaultSize={mobileLayout.details}
                minSize={15}
                className="border-t"
              >
                <JobDetails jobId={selectedJobId} />
              </ResizablePanel>
            )}

            {/* Steps Section */}
            {selectedJobId && (
              <ResizablePanel
                id="mobile-steps-panel"
                defaultSize={mobileLayout.steps}
                minSize={15}
                className="border-t"
              >
                <div className="h-full flex flex-col overflow-hidden">
                  <div className="px-4 min-h-12 border-b shrink-0 flex items-center">
                    <h2 className="font-medium">Steps</h2>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <StepList jobId={selectedJobId} selectedStepId={selectedStepId} onStepSelect={setSelectedStepId} />
                  </div>
                </div>
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
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

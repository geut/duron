'use client'

import { Play } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useActionsMetadata, useRunAction } from '@/lib/api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Textarea } from './ui/textarea'

interface CreateJobDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onJobCreated?: (jobId: string) => void
}

export function CreateJobDialog({ open, onOpenChange, onJobCreated }: CreateJobDialogProps) {
  const { data: actionsMetadata, isLoading } = useActionsMetadata()
  const runAction = useRunAction()
  const [selectedAction, setSelectedAction] = useState<string>('')
  const [jsonInput, setJsonInput] = useState<string>('{}')
  const [jsonError, setJsonError] = useState<string | null>(null)

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSelectedAction('')
      setJsonInput('{}')
      setJsonError(null)
    }
  }, [open])

  // Update JSON input when action changes
  useEffect(() => {
    if (selectedAction && actionsMetadata) {
      const action = actionsMetadata.find((a) => a.name === selectedAction)
      if (action) {
        try {
          setJsonInput(JSON.stringify(action.mockInput, null, 2))
          setJsonError(null)
        } catch {
          setJsonError('Failed to generate mock input')
        }
      }
    }
  }, [selectedAction, actionsMetadata])

  const handleRun = useCallback(() => {
    if (!selectedAction) {
      return
    }

    // Validate JSON
    let parsedInput: any
    try {
      parsedInput = JSON.parse(jsonInput)
      setJsonError(null)
    } catch {
      setJsonError('Invalid JSON format')
      return
    }

    // Run the action
    runAction.mutate(
      { actionName: selectedAction, input: parsedInput },
      {
        onSuccess: (data) => {
          onJobCreated?.(data.jobId)
          onOpenChange(false)
        },
        onError: (error) => {
          setJsonError(error instanceof Error ? error.message : 'Failed to run action')
        },
      },
    )
  }, [selectedAction, jsonInput, runAction, onJobCreated, onOpenChange])

  const handleJsonChange = useCallback(
    (value: string) => {
      setJsonInput(value)
      // Clear error when user starts typing
      if (jsonError) {
        try {
          JSON.parse(value)
          setJsonError(null)
        } catch {
          // Keep error if still invalid
        }
      }
    },
    [jsonError],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Create and Run Action Job</DialogTitle>
          <DialogDescription>Select an action and provide input data to create a new job.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          <div className="space-y-2">
            <Label htmlFor="action-select">Action</Label>
            <Select value={selectedAction} onValueChange={setSelectedAction} disabled={isLoading}>
              <SelectTrigger id="action-select" className="w-full">
                <SelectValue placeholder={isLoading ? 'Loading actions...' : 'Select an action'} />
              </SelectTrigger>
              <SelectContent>
                {actionsMetadata?.map((action) => (
                  <SelectItem key={action.name} value={action.name}>
                    {action.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="json-input">Input (JSON)</Label>
            <Textarea
              id="json-input"
              value={jsonInput}
              onChange={(e) => handleJsonChange(e.target.value)}
              className="font-mono text-sm min-h-[300px]"
              placeholder='{"key": "value"}'
            />
            {jsonError && <p className="text-sm text-destructive">{jsonError}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={runAction.isPending}>
            Cancel
          </Button>
          <Button onClick={handleRun} disabled={!selectedAction || runAction.isPending || !!jsonError}>
            <Play className="h-4 w-4 mr-2" />
            {runAction.isPending ? 'Running...' : 'Run Action'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

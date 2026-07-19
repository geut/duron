import { Editor } from '@monaco-editor/react'
import { Expand } from 'lucide-react'
import { useState } from 'react'

import { useTheme } from '@/contexts/theme-context'

import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'

interface JsonViewProps {
  value: any
  title?: string
  height?: string
}

export function JsonView({ value, title = 'JSON', height = '200px' }: JsonViewProps) {
  const { theme } = useTheme()
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  const jsonString = JSON.stringify(value, null, 2)
  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'light'

  return (
    <div className="relative group">
      <div className="border rounded-md overflow-hidden">
        <Editor
          height={height}
          language="json"
          value={jsonString}
          theme={monacoTheme}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            folding: true,
            lineNumbers: 'off',
            glyphMargin: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
            renderLineHighlight: 'none',
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
            wordWrap: 'on',
            automaticLayout: true,
            padding: {
              top: 16,
              bottom: 16,
            },
            find: {
              addExtraSpaceOnTop: true,
              autoFindInSelection: 'never',
              seedSearchStringFromSelection: 'never',
            },
          }}
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-1 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 hover:bg-background"
        onClick={() => setIsDialogOpen(true)}
        title="Expand"
      >
        <Expand className="h-4 w-4" />
      </Button>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-4xl! h-[80vh] w-[90vw]! flex flex-col">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 border rounded-md overflow-hidden">
            <Editor
              height="100%"
              language="json"
              value={jsonString}
              theme={monacoTheme}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                folding: true,
                lineNumbers: 'on',
                glyphMargin: false,
                renderLineHighlight: 'line',
                scrollbar: {
                  vertical: 'auto',
                  horizontal: 'auto',
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10,
                },
                wordWrap: 'on',
                automaticLayout: true,
                padding: {
                  top: 16,
                  bottom: 16,
                },
                find: {
                  addExtraSpaceOnTop: true,
                  autoFindInSelection: 'never',
                  seedSearchStringFromSelection: 'never',
                },
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

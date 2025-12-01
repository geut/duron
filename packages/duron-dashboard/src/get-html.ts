import fs from 'node:fs/promises'
import path from 'node:path'

let cachedHTML: string | null = null
export async function getHTML({
  url,
  enableLogin,
  showLogo,
}: {
  url: string
  enableLogin: boolean
  showLogo: boolean
}): Promise<string> {
  if (cachedHTML) return cachedHTML

  let css = ''
  {
    const fullPath = path.join(import.meta.dirname, '..', 'dist', 'init.css')
    const cssContent = await fs.readFile(fullPath, 'utf-8')
    // Escape </style> to prevent breaking the style tag
    const escapedCss = cssContent.replace(/<\/style>/gi, '<\\/style>')
    // Use replace with a function to avoid template literal issues
    css = `<style>${escapedCss}</style>`
  }

  let js = ''
  {
    const fullPath = path.join(import.meta.dirname, '..', 'dist', 'init.js')
    const jsContent = await fs.readFile(fullPath, 'utf-8')
    // Escape </script> to prevent breaking the script tag
    const escapedJs = jsContent.replace(/<\/script>/gi, '<\\/script>')
    // Use replace with a function to avoid template literal issues
    js = `<script type="module">${escapedJs}</script>`
  }

  let favicon = ''
  {
    const fullPath = path.join(import.meta.dirname, '..', 'dist', 'favicon.svg')
    const faviconFile = await fs.readFile(fullPath)
    const base64 = faviconFile.toString('base64')
    const mimeType = 'image/svg+xml'
    const dataUri = `data:${mimeType};base64,${base64}`
    favicon = `<link rel="icon" href="${dataUri}" type="${mimeType}" />`
  }

  cachedHTML = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Duron Dashboard</title>
        ${favicon}
        ${css}
        ${js}
        <script>
          function autoInit() {
            globalThis.initDuron('#root', {
              url: '${url}',
              enableLogin: ${enableLogin},
              showLogo: ${showLogo},
            })
          }

          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', autoInit)
          } else {
            autoInit()
          }
        </script>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `
  return cachedHTML
}

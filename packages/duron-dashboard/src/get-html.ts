import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Theme values that can be applied to the dashboard.
 */
export type Theme = 'light' | 'dark'

/**
 * Theme options for configuring the dashboard theme.
 * - 'light': Always use light theme
 * - 'dark': Always use dark theme
 * - 'system': Use the system preference (default)
 */
export type ThemeOption = Theme | 'system'

/**
 * Options for generating the dashboard HTML.
 */
export interface GetHTMLOptions {
  /**
   * The base URL for the Duron API.
   */
  url: string
  /**
   * Enable authentication flow (login/logout) in the dashboard.
   */
  enableLogin: boolean
  /**
   * Controls whether the Duron logo is shown in the navbar.
   */
  showLogo: boolean
  /**
   * The theme to use for the dashboard.
   * - 'light': Always use light theme
   * - 'dark': Always use dark theme
   * - 'system': Use the system preference (default)
   */
  theme?: ThemeOption
}

let cachedHTML: string | null = null

/**
 * Generate the HTML for the Duron Dashboard.
 * The HTML is cached after the first call.
 *
 * @param options - Configuration options for the dashboard
 * @returns The complete HTML string for the dashboard
 *
 * @example
 * ```ts
 * import { getHTML } from 'duron-dashboard/get-html'
 *
 * const html = await getHTML({
 *   url: 'http://localhost:3000/api',
 *   enableLogin: true,
 *   showLogo: true,
 *   theme: 'dark'
 * })
 * ```
 */
export async function getHTML({ url, enableLogin, showLogo, theme }: GetHTMLOptions): Promise<string> {
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

  const config = {
    url,
    enableLogin,
    showLogo,
    theme,
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
            globalThis.initDuron('#root', ${JSON.stringify(config, null, 2)})
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

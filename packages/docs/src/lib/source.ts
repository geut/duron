import { loader } from 'fumadocs-core/source'
import { docs } from 'fumadocs-mdx:collections/server'
import * as icons from 'lucide-static'

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: '/docs',
  icon(icon) {
    if (!icon) {
      return
    }

    // oxlint-disable-next-line import/namespace
    if (icon in icons) return icons[icon as keyof typeof icons]
  },
})

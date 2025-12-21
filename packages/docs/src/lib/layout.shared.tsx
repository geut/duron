import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

import { Logo } from '@/components/logo'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo className="h-10" />,
    },
    githubUrl: 'https://github.com/geut/duron',
  }
}

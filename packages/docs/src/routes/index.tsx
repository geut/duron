import { createFileRoute, Link } from '@tanstack/react-router'
import { HomeLayout } from 'fumadocs-ui/layouts/home'

import { Logo } from '@/components/logo'
import { baseOptions } from '@/lib/layout.shared'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <HomeLayout {...baseOptions()} className="text-center py-32 justify-center">
      <div className="flex items-center justify-center gap-3 mb-4">
        <Logo className="h-10" />
        <h1 className="font-medium text-xl">Documentation</h1>
      </div>
      <Link
        to="/docs/$"
        params={{
          _splat: '',
        }}
        className="px-3 py-2 rounded-lg bg-fd-primary text-fd-primary-foreground font-medium text-sm mx-auto"
      >
        Open Docs
      </Link>
    </HomeLayout>
  )
}

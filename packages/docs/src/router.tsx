import { createMemoryHistory, createRouter as createTanStackRouter } from '@tanstack/react-router'

import { NotFound } from '@/components/not-found'
import { routeTree } from './routeTree.gen'

const memoryHistory = createMemoryHistory({
  initialEntries: ['/'], // Pass your initial url
})

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
    basepath: import.meta.env.PROD ? '/duron' : '/',
    history: memoryHistory,
  })
}

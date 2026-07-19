import { Ban, CheckCircle2, Clock, Play, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

import { cn } from '../lib/utils'

const icons = {
  created: Clock,
  active: Play,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
}

export const statusConfig = {
  created: {
    label: 'Created',
    variant: 'outline',
    badgeClassName: '',
    iconClassName: '',
  },
  active: {
    label: 'Active',
    variant: 'outline',
    badgeClassName:
      'border-none bg-amber-600/10 text-amber-600 focus-visible:ring-amber-600/20 focus-visible:outline-none dark:bg-amber-400/10 dark:text-amber-400 dark:focus-visible:ring-amber-400/40 [a&]:hover:bg-amber-600/5 dark:[a&]:hover:bg-amber-400/5',
    iconClassName: 'rounded-full bg-amber-600 dark:bg-amber-400',
  },
  completed: {
    label: 'Completed',
    variant: 'outline',
    badgeClassName:
      'border-none bg-green-600/10 text-green-600 focus-visible:ring-green-600/20 focus-visible:outline-none dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40 [a&]:hover:bg-green-600/5 dark:[a&]:hover:bg-green-400/5',
    iconClassName: 'rounded-full bg-green-600 dark:bg-green-400',
  },
  failed: {
    label: 'Failed',
    variant: 'outline',
    badgeClassName:
      'bg-destructive/10 [a&]:hover:bg-destructive/5 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive border-none focus-visible:outline-none',
    iconClassName: 'bg-destructive rounded-full',
  },
  cancelled: {
    label: 'Cancelled',
    variant: 'secondary',
    badgeClassName: '',
    iconClassName: '',
  },
} as const

export type Status = keyof typeof statusConfig

export function BadgeStatus({ status, justIcon = false }: { status: string; justIcon?: boolean }) {
  const Icon = icons[status as Status]
  const config = statusConfig[status as Status]

  if (!config) {
    return <Badge variant="outline">{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>
  }

  if (justIcon) {
    return (
      <Badge className={cn(config.badgeClassName, 'size-4 p-0 border-none')}>
        {Icon && <Icon height={'100%'} width={'100%'} className={config.iconClassName} />}
      </Badge>
    )
  }

  return (
    <Badge variant={config.variant} className={config.badgeClassName}>
      {Icon && <Icon className={cn('mr-1 h-3 w-3', config.iconClassName)} />}
      {config.label}
    </Badge>
  )
}

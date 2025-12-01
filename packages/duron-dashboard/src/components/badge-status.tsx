import { Ban, CheckCircle2, Clock, Play, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

const icons = {
  created: Clock,
  active: Play,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
}

const colors = {
  created: 'bg-gray-100 text-gray-800 border-gray-800',
  active: 'bg-blue-100 text-blue-800 border-blue-800',
  completed: 'bg-green-100 text-green-800 border-green-800',
  failed: 'bg-red-100 text-red-800 border-red-800',
  cancelled: 'bg-yellow-100 text-yellow-800 border-yellow-800',
}

export function BadgeStatus({ status }: { status: string }) {
  const Icon = icons[status as keyof typeof icons]
  const color = colors[status as keyof typeof colors]
  return (
    <Badge variant="outline" className={color}>
      {Icon && <Icon className="mr-1 h-3 w-3" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
}

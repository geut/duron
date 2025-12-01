import { format } from 'date-fns'

export function formatDate(date: Date | string | number | undefined) {
  if (!date) return ''

  try {
    return format(new Date(date), 'yyyy-MM-dd HH:mm:ss')
  } catch (_err) {
    return ''
  }
}

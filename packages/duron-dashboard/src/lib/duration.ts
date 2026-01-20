/**
 * Calculate duration in milliseconds from start and end timestamps
 */
export function calculateDurationMs(
  startedAt: Date | string | number | null | undefined,
  finishedAt: Date | string | number | null | undefined,
): number {
  if (!startedAt) {
    return 0
  }
  const startTime = new Date(startedAt).getTime()
  const endTime = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  return endTime - startTime
}

/**
 * Calculate duration in seconds from start and end timestamps
 * @deprecated Use calculateDurationMs instead
 */
export function calculateDurationSeconds(
  startedAt: Date | string | number | null | undefined,
  finishedAt: Date | string | number | null | undefined,
): number {
  return calculateDurationMs(startedAt, finishedAt) / 1000
}

/**
 * Format milliseconds to hh:mm:ss format.
 * If the time is less than 1 second, adds milliseconds: hh:mm:ss.mmm
 */
export function formatMs(ms: number): string {
  if (ms === 0) {
    return '00:00:00'
  }

  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const milliseconds = ms % 1000

  const hh = hours.toString().padStart(2, '0')
  const mm = minutes.toString().padStart(2, '0')
  const ss = seconds.toString().padStart(2, '0')

  // If less than 1 second, show milliseconds
  if (ms < 1000) {
    const mmm = milliseconds.toString().padStart(3, '0')
    return `${hh}:${mm}:${ss}.${mmm}`
  }

  return `${hh}:${mm}:${ss}`
}

/**
 * Format duration in seconds to hh:mm:ss format.
 * If the time is less than 1 second, adds milliseconds: hh:mm:ss.mmm
 */
export function formatDurationSeconds(seconds: number): string {
  return formatMs(seconds * 1000)
}

/**
 * Calculate the expiration window duration from startedAt to expiresAt.
 * Returns null if either value is missing.
 * Format: (hh:mm:ss) or (hh:mm:ss.mmm) if less than 1 second
 */
export function formatExpirationWindow(
  startedAt: Date | string | number | null | undefined,
  expiresAt: Date | string | number | null | undefined,
): string | null {
  if (!startedAt || !expiresAt) {
    return null
  }

  const startTime = new Date(startedAt).getTime()
  const expirationTime = new Date(expiresAt).getTime()
  const durationMs = expirationTime - startTime

  return `(${formatMs(durationMs)})`
}

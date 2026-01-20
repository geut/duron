/**
 * Calculate duration in seconds from start and end timestamps
 */
export function calculateDurationSeconds(
  startedAt: Date | string | number | null | undefined,
  finishedAt: Date | string | number | null | undefined,
): number {
  if (!startedAt) {
    return 0
  }
  const startTime = new Date(startedAt).getTime()
  const endTime = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  return (endTime - startTime) / 1000
}

/**
 * Format duration in seconds to a readable string (e.g., "5.44 s")
 * Uses a maximum of 2 decimal places.
 */
export function formatDurationSeconds(seconds: number): string {
  if (seconds === 0) {
    return '0 s'
  }
  return `${seconds.toFixed(2)} s`
}

/**
 * Format milliseconds to seconds with a readable string (e.g., "5.44 s")
 * Uses a maximum of 2 decimal places.
 */
export function formatMsToSeconds(ms: number): string {
  const seconds = ms / 1000
  if (seconds === 0) {
    return '0 s'
  }
  return `${seconds.toFixed(2)} s`
}

/**
 * Calculate the expiration window duration from startedAt to expiresAt.
 * Returns null if either value is missing.
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
  const durationSeconds = (expirationTime - startTime) / 1000

  return `(${durationSeconds.toFixed(2)} s)`
}

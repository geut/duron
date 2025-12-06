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
 * Format duration in seconds to a readable string (e.g., "5.442 s")
 */
export function formatDurationSeconds(seconds: number): string {
  if (seconds === 0) {
    return '0.000 s'
  }
  return `${seconds.toFixed(3)} s`
}

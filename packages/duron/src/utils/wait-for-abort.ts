/* oxlint-disable no-confusing-void-type */

export default function waitForAbort(signal: AbortSignal) {
  let done = false
  let globalResolve: ((value: void | PromiseLike<void>) => void) | null = null
  let abortListener: (() => void) | null = null

  const promise = new Promise((resolve, reject) => {
    if (done) {
      resolve(undefined)
      return
    }

    if (signal.aborted) {
      done = true
      reject(signal.reason)
      return
    }

    globalResolve = resolve

    abortListener = () => {
      done = true
      reject(signal.reason)
    }
    signal.addEventListener('abort', abortListener)
  })

  return {
    promise,
    release: () => {
      if (done) {
        return
      }

      // Remove the abort listener to prevent memory leak
      if (abortListener) {
        signal.removeEventListener('abort', abortListener)
        abortListener = null
      }

      // Call resolve asynchronously to avoid microtask issues
      setTimeout(() => {
        globalResolve?.()
      }, 0)
      done = true
    },
  }
}

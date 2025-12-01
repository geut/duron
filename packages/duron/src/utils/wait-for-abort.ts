/** biome-ignore-all lint/suspicious/noConfusingVoidType: do not care */

export default function waitForAbort(signal: AbortSignal) {
  let done = false
  let globalResolve: ((value: void | PromiseLike<void>) => void) | null = null

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

    signal.addEventListener('abort', () => {
      done = true
      reject(signal.reason)
    })
  })

  return {
    promise,
    release: () => {
      if (done) {
        return
      }

      setTimeout(() => {
        globalResolve?.()
      }, 0)
      done = true
    },
  }
}

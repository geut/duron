import { expect } from 'bun:test'

export function expectToBeDefined<T>(value: T | undefined | null): asserts value is T {
  expect(value).toBeDefined()
  expect(value).not.toBeNull()
}

/**
 * Asserts that a promise or async function rejects with an error.
 * @param promiseOrFn - A promise or async function that should reject
 * @param errorType - Optional error type to check (defaults to Error)
 */
export async function expectRejection(
  promiseOrFn: Promise<unknown> | (() => Promise<unknown>),
  errorType: new (...args: any[]) => Error = Error,
): Promise<void> {
  const promise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn
  let errorThrown = false
  try {
    await promise
  } catch (error) {
    errorThrown = true
    expect(error).toBeInstanceOf(errorType)
  }
  expect(errorThrown).toBe(true)
}

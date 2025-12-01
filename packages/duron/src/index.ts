import type { Action } from './action.js'
import { Client, type ClientOptions } from './client.js'

export { defineAction } from './action.js'
export * from './constants.js'
export { NonRetriableError } from './errors.js'
export * from './server.js'

export const duron = <
  TActions extends Record<string, Action<any, any, TVariables>>,
  TVariables = Record<string, unknown>,
>(
  options: ClientOptions<TActions, TVariables>,
) => new Client<TActions, TVariables>(options)

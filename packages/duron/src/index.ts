import type { Action } from './action.js'
import { Client, type ClientOptions } from './client.js'

export {
  createStep,
  defineAction,
  type StepDefinition,
  type StepDefinitionHandlerContext,
  type StepDefinitionInput,
  type StepNameContext,
} from './action.js'
export * from './client.js'
export * from './constants.js'
export { NonRetriableError, UnhandledChildStepsError } from './errors.js'
export * from './server.js'
export type { TelemetryContext } from './step-manager.js'

export const duron = <
  TActions extends Record<string, Action<any, any, TVariables>>,
  TVariables = Record<string, unknown>,
>(
  options: ClientOptions<TActions, TVariables>,
) => new Client<TActions, TVariables>(options)

import type { StandardSchemaV1 } from '@standard-schema/spec'
import { SchemaError } from '@standard-schema/utils'

/**
 * Validate a Standard Schema and return the parsed value.
 * Always async to support both sync and async schemas.
 *
 * @param schema - A Standard Schema compliant validator
 * @param value - The value to validate
 * @returns The validated and transformed output value
 * @throws {SchemaError} If validation fails
 */
export async function validateSchema<T extends StandardSchemaV1>(
  schema: T,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<T>> {
  const result = await schema['~standard'].validate(value)
  if (result.issues) {
    throw new SchemaError(result.issues)
  }
  return result.value
}

/**
 * Check if a value is a Standard Schema compliant validator.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    value !== null &&
    typeof value === 'object' &&
    '~standard' in value &&
    typeof (value as any)['~standard'] === 'object' &&
    (value as any)['~standard'].version === 1
  )
}

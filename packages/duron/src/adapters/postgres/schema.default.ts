import createSchema from './schema.js'

const { schema, jobsTable, jobStepsTable, metricsTable } = createSchema('duron')

export { schema, jobsTable, jobStepsTable, metricsTable }

import createSchema from './schema.js'

const { schema, jobsTable, jobStepsTable } = createSchema('duron')

export { schema, jobsTable, jobStepsTable }

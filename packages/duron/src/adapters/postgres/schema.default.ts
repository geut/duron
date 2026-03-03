import createSchema from './schema.js'

const { schema, jobsTable, jobStepsTable, spansTable } = createSchema('duron')

export { schema, jobsTable, jobStepsTable, spansTable }

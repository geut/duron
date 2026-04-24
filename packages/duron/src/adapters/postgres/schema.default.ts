import createSchema from './schema.js'

const { schema, jobsActiveTable, jobsArchiveTable, jobStepsActiveTable, jobStepsArchiveTable, spansTable } =
  createSchema('duron')

export { schema, jobsActiveTable, jobsArchiveTable, jobStepsActiveTable, jobStepsArchiveTable, spansTable }

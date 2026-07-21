import createSchema from './schema.js'

const {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansTable,
  clientsTable,
} = createSchema('duron')

export {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansTable,
  clientsTable,
}

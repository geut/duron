import createSchema from './schema.js'

const {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  clientsTable,
} = createSchema('duron')

export {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  clientsTable,
}

import createSchema from './schema.js'

const {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansActiveTable,
  spansArchiveTable,
} = createSchema('duron')

export {
  schema,
  jobsActiveTable,
  jobsArchiveTable,
  jobStepsActiveTable,
  jobStepsArchiveTable,
  spansActiveTable,
  spansArchiveTable,
}

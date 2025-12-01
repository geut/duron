import { createHash } from 'node:crypto'

export default function generateChecksum(code: string) {
  const hash = createHash('md5')
  hash.update(code)
  return hash.digest('hex')
}

/** biome-ignore-all lint/suspicious/noConsole: we need to log for debugging */
import { execFile as baseExecFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import pRetry from 'p-retry'

const execFile = promisify(baseExecFile)
const containersCreated = new Map<string, Promise<void>>()
const containersStarted = new Map<string, Promise<void>>()

interface CreateContainerOptions {
  image: string
  containerName: string
  ports: [number, number]
  environment?: Record<string, string>
}

export async function ensureImageExists(image: string) {
  try {
    // Check if image exists locally
    const { stdout } = await execFile('docker', ['images', '-q', image])
    if (stdout.toString().trim()) {
      return // Image exists, no need to pull
    }
  } catch {
    // Image doesn't exist or error checking, proceed to pull
  }

  console.log('🔄 Pulling image...', image)
  const proc = spawn('docker', ['pull', image])

  const textDecoder = new TextDecoder()

  for await (const chunk of proc.stdout!) {
    const message = textDecoder.decode(chunk)
    console.log(message)
  }
}

export async function createContainer({ image, containerName, ports, environment }: CreateContainerOptions) {
  if (containersCreated.has(containerName)) {
    return containersCreated.get(containerName)!
  }

  const promise = (async () => {
    try {
      // Ensure the image exists before running
      await ensureImageExists(image)

      await execFile('docker', [
        'run',
        '--name',
        containerName,
        ...Object.entries(environment ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        '-p',
        `${ports[0]}:${ports[1]}`,
        '-d',
        image,
      ]).catch((error) => {
        const err = error as Error
        if (err.message.includes('is already in use by container')) {
          return execFile('docker', ['start', containerName])
        }

        throw error
      })
    } catch (error) {
      const err = error as Error
      if (!err.message.includes('Conflict.')) {
        throw new Error(`❌ Failed to start container "${containerName}": ${err.message}`)
      }
    }
  })()

  containersCreated.set(containerName, promise)
  return promise
}

export async function waitForContainer(containerName: string, expectedMessage: string) {
  if (containersStarted.has(containerName)) {
    return containersStarted.get(containerName)!
  }

  const promise = (async () => {
    const proc = spawn('docker', ['logs', '-f', containerName])

    const textDecoder = new TextDecoder()

    let done = false
    for await (const chunk of proc.stdout!) {
      const message = textDecoder.decode(chunk)
      if (message.includes(expectedMessage)) {
        done = true
        containersStarted.set(containerName, Promise.resolve())
        await new Promise((resolve) => setTimeout(resolve, 1000))
        proc.kill('SIGTERM')
        break
      }
    }

    if (!done) {
      throw new Error(`❌ Failed to start container "${containerName}": ${expectedMessage}`)
    }
  })()
  containersStarted.set(containerName, promise)
  return promise
}

export const getPostgresConnection = async ({ containerName, port }: { containerName: string; port: number }) => {
  await createContainer({
    image: 'postgres:16-alpine',
    containerName,
    ports: [port, 5432],
    environment: {
      POSTGRES_USER: 'duron',
      POSTGRES_PASSWORD: 'duron',
      POSTGRES_DB: 'duron',
    },
  })

  await waitForContainer(containerName, 'PostgreSQL init process complete')

  let name: string
  await pRetry(
    async () => {
      name = crypto.randomUUID().split('-').at(-1)!
      await execFile('docker', ['exec', containerName, 'createdb', '-U', 'duron', name])
      await execFile('docker', [
        'exec',
        containerName,
        'psql',
        '-U',
        'duron',
        '-d',
        name,
        '-c',
        'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
      ])
    },
    {
      retries: 3,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 100,
    },
  )

  return {
    CONNECTION_URL: `postgres://duron:duron@localhost:${port}/${name!}`,
    deleteDb: async () => {
      await execFile('docker', ['exec', containerName, 'dropdb', '-U', 'duron', name])
    },
  }
}

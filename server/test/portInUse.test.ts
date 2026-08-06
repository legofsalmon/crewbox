import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { portInUse } from '../src/box.ts'

/**
 * The startup pre-flight that keeps a second box from reaping the running
 * box's SFU. A box launched against a data directory whose port is already
 * held must fail before it touches anything — the reap in
 * startEmbeddedLiveKit would otherwise kill live voice mid-show.
 */
describe('portInUse', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  })

  /** Bind a throwaway listener and hand back the port it landed on. */
  function listen(host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      server = createServer()
      server.once('error', reject)
      // Port 0 lets the OS pick a free one, so the test never collides.
      server.listen(0, host, () => {
        const address = server!.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no port'))
      })
    })
  }

  it('is true when something already holds the port', async () => {
    const port = await listen()
    expect(await portInUse('127.0.0.1', port)).toBe(true)
  })

  it('is false for a free port', async () => {
    // Claim a port, then release it, so we have a port known to be free.
    const port = await listen()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    expect(await portInUse('127.0.0.1', port)).toBe(false)
  })

  it('does not leave its probe listening behind', async () => {
    // A free-port probe binds then closes; a second probe must still see it
    // free, proving the first did not keep the socket.
    const port = await listen()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    expect(await portInUse('127.0.0.1', port)).toBe(false)
    expect(await portInUse('127.0.0.1', port)).toBe(false)
  })
})

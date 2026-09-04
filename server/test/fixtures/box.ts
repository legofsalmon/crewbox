/**
 * A box in its own process, for the tests that are about the process dying.
 *
 * An unhandled `error` event and a throw inside a socket callback both end a
 * real box. They do not end a vitest worker — vitest catches them and reports
 * them alongside a test that passed — so an in-process test for "one packet
 * takes the box down" quietly proves nothing. This is the same box, started
 * the same way, where exiting means exiting.
 *
 * Prints `listening <port>` on stdout when it is up, and nothing else.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachWs, buildApp } from '../../src/app.ts'
import { openDb } from '../../src/db.ts'
import { Store } from '../../src/store.ts'

const dir = mkdtempSync(join(tmpdir(), 'crewbox-abuse-box-'))
const db = openDb(join(dir, 'test.db'))
const app = buildApp({
  store: new Store(db),
  eventPin: '9999',
  adminPassword: 'abuse-admin-pass',
  filesDir: dir,
  dataDir: dir,
  modules: ['chat', 'patch'],
  logger: false,
})
await app.listen({ host: '127.0.0.1', port: 0 })
attachWs(app)
const address = app.server.address()
process.stdout.write(`listening ${typeof address === 'object' && address ? address.port : 0}\n`)

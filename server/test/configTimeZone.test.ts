import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicConfig } from '@crewbox/shared'
import { buildApp, type App } from '../src/app.ts'
import { openDb } from '../src/db.ts'
import { Store } from '../src/store.ts'

/**
 * The festival's zone reaches every device, so the show log reads in the
 * field's clock wherever it is opened. Only a zone somebody set: the box's
 * process zone is not a stand-in, because a box imaged with UTC would put
 * every entry an hour out in July.
 */

let dir: string
let app: App

const boot = (timeZone?: string): App => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-tz-'))
  const store = new Store(openDb(':memory:'))
  store.createChannel('general', 'public', 'Everyone')
  app = buildApp({
    store,
    eventPin: '9999',
    filesDir: dir,
    dataDir: dir,
    logger: false,
    ...(timeZone ? { timeZone } : {}),
  })
  return app
}

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const config = async (): Promise<PublicConfig> =>
  (await app.inject({ url: '/api/config' })).json() as PublicConfig

describe("the festival's zone in the public config", () => {
  it('is sent when the box was given one', async () => {
    boot('Europe/London')
    expect((await config()).timeZone).toBe('Europe/London')
  })

  it('is absent when it was not, rather than the process zone', async () => {
    boot()
    expect(await config()).not.toHaveProperty('timeZone')
  })
})

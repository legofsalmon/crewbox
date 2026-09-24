/**
 * License the e2e box before it starts, so the suite runs against a box that
 * can be set up — the shipped policy is "trial, then lock", and a locked box
 * would refuse the first-run setup admin.spec.ts begins with.
 *
 * Writes the token where the box keeps it (the settings table), bound to this
 * machine's own id, read the same way the box reads it. e2e/licence.spec.ts
 * then releases it to check the locked state, and re-licenses the box through
 * offline activation in the panel.
 *
 * Run by the webServer command in playwright.config.ts, with DATA_DIR set.
 */
import { join } from 'node:path'
import { openDb } from '../server/src/db.ts'
import { Store } from '../server/src/store.ts'
import { readFingerprint } from '../server/src/licence/fingerprint.ts'
import { KEY_SETTING, TOKEN_SETTING } from '../server/src/licence/service.ts'
import { E2E_LICENCE_KEY, mintLicenceToken } from './licenceKey.ts'

const dataDir = process.env.DATA_DIR
const fingerprint = readFingerprint()
if (!dataDir) throw new Error('seedLicence: DATA_DIR is not set')
if (!fingerprint) throw new Error('seedLicence: this machine has no readable machine id')

const db = openDb(join(dataDir, 'crewbox.db'))
const store = new Store(db)
store.setSetting(TOKEN_SETTING, mintLicenceToken(fingerprint))
store.setSetting(KEY_SETTING, E2E_LICENCE_KEY)
db.close()

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The release's shape, where it keeps the signing key and the screens.
 *
 * A workflow can't be run here, and its mistakes show up as a release that
 * failed or, worse, one that didn't: the key in a job that runs `npm ci` and
 * every dependency's install script, a box built on screens of its own rather
 * than the signed ones, a publish job that swept the screens' artifacts in
 * among the assets. Each is one careless edit away, so read the files and
 * hold them to it.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Each job's lines, keyed by its id, with comment lines left out. */
function jobsIn(file) {
  const text = readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')
  const jobs = new Map()
  let inJobs = false
  let current
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue
    if (/^jobs:\s*$/.test(line)) inJobs = true
    const header = inJobs && /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)
    if (header) jobs.set((current = header[1]), [])
    else if (current) jobs.get(current).push(line)
  }
  return new Map([...jobs].map(([id, lines]) => [id, lines.join('\n')]))
}

/** The names a job uploads its artifacts under. */
const uploads = (job) =>
  [...job.matchAll(/uses: actions\/upload-artifact@\S+\n\s+with:\n\s+name: (\S+)/g)].map(
    (match) => match[1]
  )

const release = jobsIn('release.yml')
const ci = jobsIn('ci.yml')
const INSTALLS = /\bnpm (?:ci|i|install|run)\b|\bnpx\b|\byarn\b|\bpnpm\b|actions\/setup-node/

describe('the release signing key', () => {
  it('is in the screens-signing and publishing jobs and nowhere else', () => {
    const holding = [...release].filter(([, job]) => job.includes('secrets.RELEASE_SIGNING_KEY'))
    expect(holding.map(([id]) => id).sort()).toEqual(['release', 'sign-web'])
  })

  it.each(['sign-web', 'release'])('is in a job, %s, that installs and runs nothing', (id) => {
    expect(release.get(id)).not.toMatch(INSTALLS)
  })

  it('is given to the one step that signs, not to the whole job', () => {
    const job = release.get('sign-web')
    expect(job).not.toMatch(/^ {4}env:/m)
    expect(job).toMatch(
      /RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}\n.*\n\s+run: node scripts\/sign-web\.mjs web\/dist "\$V"/
    )
  })
})

describe('the screens in a release', () => {
  it('are built once, in a job of their own', () => {
    const building = [...release].filter(([, job]) => /npm run build(?: -w web|:native)/.test(job))
    expect(building.map(([id]) => id)).toEqual(['web'])
    expect(uploads(release.get('web'))).toEqual(['web-build'])
  })

  it('are signed from that build, after the checkout that would wipe it', () => {
    const job = release.get('sign-web')
    expect(job).toMatch(/needs: \[validate, web\]/)
    expect(job.indexOf('actions/checkout')).toBeLessThan(job.indexOf('name: web-build'))
    expect(uploads(job)).toEqual(['web-signed'])
  })

  it.each(['box', 'mac', 'apk'])('are carried by %s as signed', (id) => {
    const job = release.get(id)
    expect(job).toMatch(/needs: \[validate, sign-web\]/)
    expect(job).toMatch(/name: web-signed\n\s+path: web\/dist/)
    expect(job.indexOf('actions/checkout')).toBeLessThan(job.indexOf('name: web-signed'))
  })

  it.each(['box', 'mac'])('fail the %s smoke test when a box serves them unsigned', (id) => {
    expect(release.get(id)).toMatch(/CREWBOX_SMOKE_SIGNED: '1'/)
  })

  it('are checked in the Android project and again in the APK', () => {
    const job = release.get('apk')
    const synced = job.indexOf('cap sync')
    const project = job.indexOf('web-sums.mjs native/android/app/src/main/assets/public')
    const built = job.indexOf('./gradlew')
    const packed = job.indexOf('web-sums.mjs "$RUNNER_TEMP/apk/assets/public"')
    expect(synced).toBeGreaterThan(-1)
    expect(project).toBeGreaterThan(synced)
    expect(built).toBeGreaterThan(project)
    expect(packed).toBeGreaterThan(built)
  })

  it('stay out of what is published', () => {
    const published = ['box', 'mac', 'apk'].flatMap((id) => uploads(release.get(id)))
    expect(published.length).toBeGreaterThan(0)
    for (const name of published) expect(name).toMatch(/^release-/)
    const screens = ['web', 'sign-web'].flatMap((id) => uploads(release.get(id)))
    expect(screens).toEqual(['web-build', 'web-signed'])
    for (const name of screens) expect(name).not.toMatch(/^release-/)
    expect(release.get('release')).toMatch(/pattern: release-\*/)
  })
})

describe('CI', () => {
  it('signs the screens with a key made for the run, and nothing of the release', () => {
    const job = ci.get('box')
    expect(job).toMatch(/openssl genpkey -algorithm ed25519/)
    expect(job).toMatch(/node scripts\/sign-web\.mjs web\/dist/)
    expect(job).not.toMatch(/secrets\./)
    expect(job).toMatch(/CREWBOX_SMOKE_SIGNED: '1'/)
  })
})

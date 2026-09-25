import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

/** Unique names so tests sharing one server never collide. */
export const uniqueName = (base: string) =>
  `${base} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let crewCounter = 0

/**
 * Every context `newDevice` opened, so it can be shut again.
 *
 * The suite runs serially in one browser, and most specs never closed the
 * devices they made — so by the end of a run thirty-odd contexts were still
 * open, each holding a live page, a WebSocket to the box and an IndexedDB
 * connection, all still receiving. That is the "flakiness" the patch
 * changeover spec papers over with a twenty-second timeout: not a race in
 * the app, a browser doing the work of thirty idle crew phones.
 */
const openContexts: BrowserContext[] = []

/**
 * `test`, with an automatic fixture that closes those contexts.
 *
 * Specs import this rather than Playwright's own, so no spec has to remember
 * — and a spec that closes its own device early is unaffected, because
 * closing a closed context is a no-op.
 */
export const test = base.extend<{ closeDevices: void }>({
  closeDevices: [
    // eslint-disable-next-line no-empty-pattern -- Playwright's fixture shape.
    async ({}, use) => {
      await use()
      await Promise.all(openContexts.splice(0).map((context) => context.close().catch(() => {})))
    },
    { auto: true },
  ],
})

/**
 * A fresh "device": isolated storage (own IndexedDB/localStorage), joined
 * to the event as a new crew member through the real join flow.
 */
export const newDevice = async (browser: Browser, crewName?: string): Promise<Page> => {
  const context = await browser.newContext()
  openContexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  await page.goto('/')
  const name = crewName ?? `Crew${Date.now().toString(36).slice(-4)}${crewCounter++}`
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Event PIN').fill('4242')
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  // Wait for the composer, not the brand: the join screen has its own
  // <h1>Crewbox</h1>, so heading text alone can pass before login completes.
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

/**
 * Until a page's chat cache holds what the app shows at a start with no
 * signal: the snapshot of its channels and crew (lib/db.ts).
 *
 * Chat is on screen before that is saved. The page draws the box's welcome
 * first and saves the snapshot after (store.ts, persistSnapshot), so a test
 * that cuts a page off and reloads it the moment chat shows can catch it
 * with nothing cached. That page shows "Can't reach the crew server", a
 * first start's screen, instead of the banner a returning phone shows.
 */
export const untilChatCached = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(async () => {
        const saved = (name: string) =>
          new Promise<boolean>((resolve) => {
            const open = indexedDB.open(name)
            open.onerror = () => resolve(false)
            open.onsuccess = () => {
              const db = open.result
              const done = (value: boolean) => {
                db.close()
                resolve(value)
              }
              if (!db.objectStoreNames.contains('kv')) return done(false)
              const get = db.transaction('kv').objectStore('kv').get('snapshot')
              get.onsuccess = () => done(get.result !== undefined)
              get.onerror = () => done(false)
            }
          })
        for (const { name } of await indexedDB.databases()) {
          if (name && (await saved(name))) return true
        }
        return false
      })
    )
    .toBe(true)

/**
 * The apps' keeping of sign-ins (SessionsPlugin), for an init script added
 * after the one that stands the app in: the iPhone's Keychain or Android's
 * Keystore, stood in for by the tab's sessionStorage, which a reload keeps
 * and the page itself never touches, so the page's storage and the app's are
 * apart as on a phone. Each call is kept for `keychainCalls`.
 */
export function keepSignInsInTheApp(): void {
  const w = window as unknown as {
    Capacitor?: { Plugins?: Record<string, unknown> }
    __keychainCalls?: string[]
  }
  const plugins = w.Capacitor?.Plugins
  if (!plugins) return
  const calls: string[] = []
  w.__keychainCalls = calls
  const kept = (): Record<string, string> =>
    JSON.parse(sessionStorage.getItem('__keychain') ?? '{}') as Record<string, string>
  const keep = (sessions: Record<string, string>) =>
    sessionStorage.setItem('__keychain', JSON.stringify(sessions))
  // Each answers a little later, as a call across the bridge to the
  // Keychain does, so a page that doesn't wait for one goes on without it.
  const answered = () => new Promise((resolve) => setTimeout(resolve, 150))
  plugins.CrewboxSessions = {
    load: async () => {
      calls.push('load')
      await answered()
      return { sessions: kept() }
    },
    save: async ({ name, token }: { name: string; token: string }) => {
      calls.push(`save ${name}`)
      await answered()
      keep({ ...kept(), [name]: token })
    },
    forget: async ({ name }: { name: string }) => {
      calls.push(`forget ${name}`)
      await answered()
      const sessions = kept()
      delete sessions[name]
      keep(sessions)
    },
  }
}

/** The sign-ins the stood-in app keeps, by name. */
export const keychainOf = (page: Page) =>
  page.evaluate(
    () => JSON.parse(sessionStorage.getItem('__keychain') ?? '{}') as Record<string, string>
  )

/** What the stood-in app's keeping of sign-ins has been asked, on the page as loaded. */
export const keychainCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __keychainCalls: string[] }).__keychainCalls)

/**
 * The apps' own files (RecordsPlugin, web/src/lib/appCopy.ts), for an init
 * script added after the one that stands the app in: a folder per event and
 * a file per slot, stood in for by the tab's sessionStorage, which a reload
 * keeps and a wipe of the page's IndexedDB and localStorage doesn't reach, as
 * on a phone.
 */
export function keepRecordsInTheApp(): void {
  const w = window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }
  const plugins = w.Capacitor?.Plugins
  if (!plugins) return
  type Folders = Record<string, Record<string, string>>
  const kept = (): Folders => JSON.parse(sessionStorage.getItem('__records') ?? '{}') as Folders
  const keep = (folders: Folders) => sessionStorage.setItem('__records', JSON.stringify(folders))
  // A little later, as a call across the bridge is, and in the order asked.
  const answered = () => new Promise((resolve) => setTimeout(resolve, 20))
  plugins.CrewboxRecords = {
    readAll: async ({ slot }: { slot: string }) => {
      await answered()
      const values: Record<string, string> = {}
      for (const [event, slots] of Object.entries(kept())) {
        const value = slots[slot]
        if (value !== undefined) values[event] = value
      }
      return { values }
    },
    write: async ({ event, slot, value }: { event: string; slot: string; value: string }) => {
      await answered()
      const folders = kept()
      folders[event] = { ...folders[event], [slot]: value }
      keep(folders)
    },
    remove: async ({ event, slot }: { event: string; slot?: string }) => {
      await answered()
      const folders = kept()
      if (slot === undefined) delete folders[event]
      else if (folders[event]) delete folders[event][slot]
      keep(folders)
    },
  }
}

/**
 * The apps' running of screens from a box (ScreensPlugin, web/src/lib/appScreens.ts),
 * for an init script added after the one that stands the app in: what the
 * page tells it is kept for `screensCalls`, on the page as loaded.
 */
export function keepScreensInTheApp(): void {
  const w = window as unknown as {
    Capacitor?: { Plugins?: Record<string, unknown> }
    __screensCalls?: string[]
  }
  const plugins = w.Capacitor?.Plugins
  if (!plugins) return
  const calls: string[] = []
  w.__screensCalls = calls
  plugins.CrewboxScreens = {
    prepare: async () => {
      calls.push('prepare')
      return { result: 'unsigned', reason: 'stood in' }
    },
    use: async ({ event, version }: { event: string; version: string }) => {
      calls.push(`use ${event} ${version}`)
    },
    ready: async ({ version }: { version: string }) => {
      // Said while the blank screen boot shows is said too early.
      const blank = document.querySelector('.boot-screen') ? ' on the blank screen' : ''
      calls.push(`ready ${version}${blank}`)
    },
  }
}

/** What the stood-in app has been told about its screens, on the page as loaded. */
export const screensCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __screensCalls: string[] }).__screensCalls)

/** What the stood-in app's files hold, by event and slot. */
export const recordsOf = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem('__records') ?? '{}') as Record<
        string,
        Record<string, string>
      >
  )

/** A box as the apps' search reports one: `FoundService` in web/src/lib/server.ts. */
export interface FoundService {
  name: string
  addresses: string[]
  port: number
  txt: Record<string, string>
}

/** What the apps' scanner hands the page: `ScanOutcome` in web/src/lib/server.ts. */
export type ScanOutcome =
  | { result: 'scanned'; text: string }
  | { result: 'cancelled' }
  | { result: 'denied' }
  | { result: 'unavailable' }

/** What the apps' Wi-Fi join hands the page: `WifiOutcome` in web/src/lib/server.ts. */
export interface WifiOutcome {
  result: 'joined' | 'saved' | 'known' | 'declined' | 'failed' | 'invalid' | 'unavailable'
}

/** A box the Android app was told of (NetworkPlugin), and when it answered. */
export interface BoxWifiCall {
  origin: string
  answered: boolean
}

/**
 * One of the phone apps, with its search for boxes (DiscoveryPlugin), its QR
 * scanner (ScannerPlugin) and its Wi-Fi join (WifiPlugin) stood in for. Each
 * start "finds" `boxes`, what it was asked is kept for `discoveryCalls`, and
 * `announce` changes what it has found. Each scan hands back what
 * `scanWillGive` queued, or is backed out of, and each network asked for is
 * kept for `wifiCalls` and answered as `wifiWillGive` queued, or turned down.
 * The Android one also has its hold on the Wi-Fi (NetworkPlugin): each box
 * it is told of is kept for `boxWifiCalls`, and answered after
 * `boxWifiTakes`, at once unless told otherwise.
 */
export const appWithDiscovery = async (
  browser: Browser,
  platform: 'android' | 'ios',
  boxes: FoundService[],
  options: Parameters<Browser['newContext']>[0] = {}
): Promise<Page> => {
  const context = await browser.newContext(options)
  openContexts.push(context)
  await context.addInitScript(
    ({ platform, boxes }) => {
      const calls: string[] = []
      const listeners: Record<string, ((event: unknown) => void)[]> = {}
      const emit = (event: string, data: unknown) => {
        for (const listener of listeners[event] ?? []) listener(data)
      }
      let found = boxes
      const w = window as unknown as Record<string, unknown>
      w.__discovery = calls
      const scans: unknown[] = []
      const scanner: string[] = []
      w.__scans = scans
      w.__scanner = scanner
      const wifiAnswers: unknown[] = []
      const networks: unknown[] = []
      w.__wifiAnswers = wifiAnswers
      w.__networks = networks
      const boxWifi: { origin: string; answered: boolean }[] = []
      w.__boxWifi = boxWifi
      w.__boxWifiTakes = 0
      w.__announce = (next: typeof boxes) => {
        found = next
        emit('boxes', { boxes: found })
      }
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => platform,
        Plugins: {
          CrewboxDiscovery: {
            start: async () => {
              calls.push('start')
              setTimeout(() => {
                emit('state', { state: 'searching' })
                emit('boxes', { boxes: found })
              }, 0)
            },
            stop: async () => {
              calls.push('stop')
            },
            openSettings: async () => {
              calls.push('openSettings')
            },
            addListener: (event: string, listener: (event: unknown) => void) => {
              ;(listeners[event] ??= []).push(listener)
              return {
                remove: async () => {
                  listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener)
                },
              }
            },
          },
          CrewboxScanner: {
            scan: async () => {
              scanner.push('scan')
              return scans.shift() ?? { result: 'cancelled' }
            },
            openSettings: async () => {
              scanner.push('openSettings')
            },
          },
          CrewboxWifi: {
            join: async (network: unknown) => {
              networks.push(network)
              return wifiAnswers.shift() ?? { result: 'declined' }
            },
          },
          ...(platform === 'android'
            ? {
                CrewboxNetwork: {
                  useBox: ({ origin }: { origin: string }) => {
                    const call = { origin, answered: false }
                    boxWifi.push(call)
                    return new Promise((resolve) =>
                      setTimeout(() => {
                        call.answered = true
                        resolve({ onWifi: true })
                      }, w.__boxWifiTakes as number)
                    )
                  },
                },
              }
            : {}),
        },
      }
    },
    { platform, boxes }
  )
  await context.addInitScript(keepSignInsInTheApp)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw new Error(`Page error: ${error.message}`)
  })
  return page
}

/** What the stood-in search has found from now on. */
export const announce = (page: Page, boxes: FoundService[]) =>
  page.evaluate(
    (boxes) => (window as unknown as { __announce: (b: unknown[]) => void }).__announce(boxes),
    boxes
  )

/** What the stood-in search has been asked to do, in order. */
export const discoveryCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __discovery: string[] }).__discovery)

/** What the stood-in scanner hands back, one outcome per scan, on the page as loaded. */
export const scanWillGive = (page: Page, ...outcomes: ScanOutcome[]) =>
  page.evaluate(
    (outcomes) => (window as unknown as { __scans: unknown[] }).__scans.push(...outcomes),
    outcomes
  )

/** What the stood-in scanner has been asked to do, in order. */
export const scannerCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __scanner: string[] }).__scanner)

/** What the stood-in Wi-Fi join answers, one outcome per network, on the page as loaded. */
export const wifiWillGive = (page: Page, ...outcomes: WifiOutcome[]) =>
  page.evaluate(
    (outcomes) =>
      (window as unknown as { __wifiAnswers: unknown[] }).__wifiAnswers.push(...outcomes),
    outcomes
  )

/** The networks the stood-in Wi-Fi join has been asked to join, in order. */
export const wifiCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __networks: unknown[] }).__networks)

/** How long the stood-in Android app takes to answer each box it is told of from now on. */
export const boxWifiTakes = (page: Page, ms: number) =>
  page.evaluate((ms) => ((window as unknown as { __boxWifiTakes: number }).__boxWifiTakes = ms), ms)

/** The boxes the stood-in Android app has been told of, in order, and whether it has answered. */
export const boxWifiCalls = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __boxWifi: BoxWifiCall[] }).__boxWifi.map((call) => ({ ...call }))
  )

/** Open the patch module's sheet selector from the sidebar. */
export const openPatch = async (page: Page) => {
  await page.getByRole('button', { name: 'All sheets…' }).click()
  await expect(page.getByRole('heading', { name: 'Patch Sheets' })).toBeVisible()
}

export const createSheet = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '+ New Sheet' }).click()
  await page.locator('#new-sheet-name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('table')).toBeVisible()
  // A new sheet has no columns. It used to seed an "Act 1" onto the event's
  // running order, which put a band nobody had booked in front of every
  // department on the box — so the act comes from the lineup now, the way a
  // real one does. Named, because the grid's cells are labelled by act.
  await addAct(page, 'Act 1')
}

/** Put an act on the running order from the sheet's own Lineup popover. */
export const addAct = async (page: Page, name: string) => {
  // Exact: the empty grid's own prompt reads "add one in the lineup".
  await page.getByRole('button', { name: 'Lineup', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Lineup' })).toBeVisible()
  await page.getByRole('button', { name: '+ Add Act' }).click()
  const field = page.getByLabel('Act name').last()
  await field.fill(name)
  await field.blur()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Lineup' })).toBeHidden()
}

export const openSheetByName = async (page: Page, name: string) => {
  // Scope to the main pane — the sidebar's Patch Sheets section lists the
  // same title, and two matches trip Playwright's strict mode.
  await page.locator('main').getByText(name).first().click()
  await expect(page.locator('table')).toBeVisible()
}

export const cell = (page: Page, act: string, channel: string, field: string) =>
  page.getByLabel(`${act}, channel ${channel}, ${field}`)

export const commitCell = async (
  page: Page,
  act: string,
  channel: string,
  field: string,
  value: string
) => {
  const input = cell(page, act, channel, field)
  await input.click()
  await input.fill(value)
  await input.press('Enter')
}

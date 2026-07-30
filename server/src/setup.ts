import { escapeHtml, PAGE_CSS } from './html.ts'

/**
 * First-run setup: the three things an admin needs to set before crew arrive,
 * asked once, in a browser, on the screen that opens when the box starts.
 *
 * Before this, those three lived in three different places — the event PIN in
 * an env var (or minted at random and only visible in the terminal), the
 * Wi-Fi hint in the admin panel behind a join, and the event name nowhere at
 * all. An admin double-clicking a downloaded binary met a QR code and no way
 * to say what event it was for.
 *
 * The window is open only while nobody has joined. That isn't a weaker rule
 * than the admin panel's — before the first join, anyone who can reach the
 * box can join and become admin anyway (see /api/join), so a setup form on
 * the same network grants nothing new. The moment someone joins, this page
 * stops working and the admin panel is the only way in.
 */

export interface SetupValues {
  eventName: string
  wifiSsid: string
  eventPin: string
  /**
   * The admin password field, which has three states worth telling apart:
   *
   * - a string: the password this box minted at startup, pre-filled so the
   *   admin leaves knowing it rather than hunting for the console;
   * - `''`: a password exists from an earlier run and only its hash is kept,
   *   so the field starts blank and blank means "leave it alone";
   * - `undefined`: ADMIN_PASSWORD is set in the environment and the box is
   *   not allowed to change it, so the field is hidden rather than offering
   *   an edit that would silently do nothing.
   */
  adminPassword?: string
  /**
   * Network choices, offered as dropdowns of the adapters this machine
   * actually has — asked here because the on-site alternative is a terminal
   * and an environment variable, discovered mid-get-in. Fields pinned by an
   * environment variable are hidden rather than shown as edits that would
   * silently lose.
   */
  network: {
    adapters: Array<{ name: string; address: string }>
    crewIface: string
    dmxMode: string
    dmxIface: string
    dmxUniverses: string
    fromEnv: { iface: boolean; dmxMode: boolean; dmxIface: boolean; dmxUniverses: boolean }
  }
}

export interface SetupPageOptions {
  values: SetupValues
  /** The address crew will use, for the "this is what they'll type" line. */
  base: string
  /** Validation message to show above the form, when a submit bounced. */
  error?: string
  /**
   * Environment problems worth raising before anyone sets up an event —
   * a dead network is much cheaper to fix now than after the posters are
   * printed. Only genuine problems belong here: this is a setup form, not a
   * dashboard, and "no internet" is normal and must stay silent.
   */
  warnings?: { label: string; detail: string; fix?: string }[]
}

const field = (id: string, label: string, value: string, hint: string, attrs: string): string => `
  <label for="${id}">${escapeHtml(label)}</label>
  <input id="${id}" name="${id}" value="${escapeHtml(value)}" ${attrs}>
  <span class="hint">${escapeHtml(hint)}</span>`

const select = (
  id: string,
  label: string,
  value: string,
  hint: string,
  options: Array<{ value: string; label: string }>
): string => `
  <label for="${id}">${escapeHtml(label)}</label>
  <select id="${id}" name="${id}">${options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
    )
    .join('')}</select>
  <span class="hint">${escapeHtml(hint)}</span>`

/** "192.168.1.50 — Wi-Fi" reads better than either half alone. */
const adapterOptions = (
  adapters: Array<{ name: string; address: string }>,
  blankLabel: string
): Array<{ value: string; label: string }> => [
  { value: '', label: blankLabel },
  ...adapters.map((a) => ({ value: a.address, label: `${a.address} — ${a.name}` })),
]

/**
 * The networks block: which adapter faces the crew, and which (if any) the
 * lighting listener reads. Open by default only on a machine where the
 * choice exists — a one-adapter laptop gets it folded away.
 */
const networkSection = (network: SetupValues['network']): string => {
  const { adapters, fromEnv } = network
  const crew = fromEnv.iface
    ? ''
    : select(
        'crewIface',
        'Crew network',
        network.crewIface,
        'The network crew phones are on. The join QR, and everything else the box shows, points here — and the box answers only here.',
        adapterOptions(adapters, 'All networks — first adapter wins')
      )
  const mode = fromEnv.dmxMode
    ? ''
    : select(
        'dmxMode',
        'Lighting network listening',
        network.dmxMode || 'off',
        'Watch the lighting network, read-only, to check the patch against what the desk really sends.',
        [
          { value: 'off', label: 'Off' },
          { value: 'sacn', label: 'sACN' },
          { value: 'artnet', label: 'Art-Net' },
          { value: 'both', label: 'Both' },
        ]
      )
  const dmxIface = fromEnv.dmxIface
    ? ''
    : select(
        'dmxIface',
        'Lighting network adapter',
        network.dmxIface,
        'The adapter plugged into the lighting network. Only read from — the box never transmits there.',
        adapterOptions(adapters, 'Let the OS choose')
      )
  const universes = fromEnv.dmxUniverses
    ? ''
    : field(
        'dmxUniverses',
        'sACN universes',
        network.dmxUniverses,
        'Which universes to watch, e.g. 1-8,101. Leave blank for 1-16. The panel will say if the desk sends others.',
        'maxlength="200" placeholder="1-16" autocomplete="off" spellcheck="false"'
      )
  const body = crew + mode + dmxIface + universes
  if (!body) return ''
  return `<details${adapters.length > 1 ? ' open' : ''}><summary>Networks</summary>${body}
  <span class="hint">Network changes picked here apply when the box next starts; everything else on this page applies immediately.</span>
  </details>`
}

export function setupPage({ values, base, error, warnings = [] }: SetupPageOptions): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Crewbox</title>
<style>${PAGE_CSS}
  form { text-align: left; margin-top: 24px; }
  label { display: block; font-weight: 600; margin-top: 18px; }
  input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 12px 14px;
          font: inherit; font-size: 16px; color: #f2eee7; background: #1b1815;
          border: 1px solid #3a342c; border-radius: 10px; }
  input:focus, select:focus { outline: 2px solid #f5b73e; outline-offset: 1px; }
  select { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 12px 14px;
           font: inherit; font-size: 16px; color: #f2eee7; background: #1b1815;
           border: 1px solid #3a342c; border-radius: 10px; }
  details { margin-top: 22px; border: 1px solid #3a342c; border-radius: 10px; padding: 4px 14px 14px; }
  summary { font-weight: 700; padding: 10px 0 6px; cursor: pointer; }
  .hint { display: block; color: #a29a8c; font-size: 13px; margin-top: 5px; }
  button { width: 100%; margin-top: 26px; padding: 14px; font: inherit; font-size: 17px;
           font-weight: 700; color: #12100e; background: #f5b73e;
           border: 0; border-radius: 10px; cursor: pointer; }
  .error { margin-top: 18px; padding: 10px 12px; border-radius: 10px;
           background: #4a1f1c; color: #ffd9d4; text-align: left; font-size: 15px; }
  .warn { margin-top: 18px; padding: 12px 14px; border-radius: 10px; text-align: left;
          background: #3a2c14; color: #f6e3bd; font-size: 14px; }
  .warn b { display: block; color: #f5b73e; }
  .warn p { margin: 4px 0 0; }
  .warn + .warn { margin-top: 8px; }
  .skip { display: block; margin-top: 18px; font-size: 14px; }
</style></head><body><div class="card">
  <h1>Crewbox</h1>
  <p class="meta">Two minutes of setup, then crew scan a QR and you're running.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  ${warnings
    .map(
      (w) =>
        `<div class="warn"><b>${escapeHtml(w.label)}</b><p>${escapeHtml(w.detail)}</p>${
          w.fix ? `<p>${escapeHtml(w.fix)}</p>` : ''
        }</div>`
    )
    .join('')}
  <form method="post" action="/setup">
    ${field('eventName', 'Event name', values.eventName, 'Shown to crew when they join. Change it any time.', 'maxlength="64" placeholder="e.g. Ashton Court 2026" autofocus')}
    ${field('wifiSsid', 'Wi-Fi network', values.wifiSsid, "The network crew join to reach this box. Leave blank if you don't know it yet.", 'maxlength="64" placeholder="e.g. CrewNet" autocomplete="off" autocapitalize="none" spellcheck="false"')}
    ${field('eventPin', 'Event PIN', values.eventPin, 'Crew type this once to join. Already filled in with a random one — change it if you like.', 'minlength="4" maxlength="64" inputmode="numeric" autocomplete="off" required')}
    ${
      values.adminPassword === undefined
        ? ''
        : field(
            'adminPassword',
            'Admin password',
            values.adminPassword,
            values.adminPassword
              ? 'Yours, not the crew’s — it opens the admin panel from the cog. Write it down now; it is never shown again.'
              : 'Opens the admin panel from the cog. Leave blank to keep the password this box already has.',
            'minlength="8" maxlength="128" autocomplete="off" autocapitalize="none" spellcheck="false"'
          )
    }
    ${networkSection(values.network)}
    <button type="submit">Save and show the QR</button>
  </form>
  <p class="meta">Crew will use <strong>${escapeHtml(base.replace(/^https?:\/\//, ''))}</strong></p>
  <a class="skip" href="/connect">Skip — I'll set this up later in the app</a>
</div></body></html>`
}

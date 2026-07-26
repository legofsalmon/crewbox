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
}

export interface SetupPageOptions {
  values: SetupValues
  /** The address crew will use, for the "this is what they'll type" line. */
  base: string
  /** Validation message to show above the form, when a submit bounced. */
  error?: string
}

const field = (id: string, label: string, value: string, hint: string, attrs: string): string => `
  <label for="${id}">${escapeHtml(label)}</label>
  <input id="${id}" name="${id}" value="${escapeHtml(value)}" ${attrs}>
  <span class="hint">${escapeHtml(hint)}</span>`

export function setupPage({ values, base, error }: SetupPageOptions): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Crewbox</title>
<style>${PAGE_CSS}
  form { text-align: left; margin-top: 24px; }
  label { display: block; font-weight: 600; margin-top: 18px; }
  input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 12px 14px;
          font: inherit; font-size: 16px; color: #f2eee7; background: #1b1815;
          border: 1px solid #3a342c; border-radius: 10px; }
  input:focus { outline: 2px solid #f5b73e; outline-offset: 1px; }
  .hint { display: block; color: #a29a8c; font-size: 13px; margin-top: 5px; }
  button { width: 100%; margin-top: 26px; padding: 14px; font: inherit; font-size: 17px;
           font-weight: 700; color: #12100e; background: #f5b73e;
           border: 0; border-radius: 10px; cursor: pointer; }
  .error { margin-top: 18px; padding: 10px 12px; border-radius: 10px;
           background: #4a1f1c; color: #ffd9d4; text-align: left; font-size: 15px; }
  .skip { display: block; margin-top: 18px; font-size: 14px; }
</style></head><body><div class="card">
  <h1>Crewbox</h1>
  <p class="meta">Two minutes of setup, then crew scan a QR and you're running.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/setup">
    ${field('eventName', 'Event name', values.eventName, 'Shown to crew when they join. Change it any time.', 'maxlength="64" placeholder="e.g. Ashton Court 2026" autofocus')}
    ${field('wifiSsid', 'Wi-Fi network', values.wifiSsid, "The network crew join to reach this box. Leave blank if you don't know it yet.", 'maxlength="64" placeholder="e.g. CrewNet" autocomplete="off" autocapitalize="none" spellcheck="false"')}
    ${field('eventPin', 'Event PIN', values.eventPin, 'Crew type this once to join. Already filled in with a random one — change it if you like.', 'minlength="4" maxlength="64" inputmode="numeric" autocomplete="off" required')}
    <button type="submit">Save and show the QR</button>
  </form>
  <p class="meta">Crew will use <strong>${escapeHtml(base.replace(/^https?:\/\//, ''))}</strong></p>
  <a class="skip" href="/connect">Skip — I'll set this up later in the app</a>
</div></body></html>`
}

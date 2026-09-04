// Soak test: N fake crew members chatting through the real join + WS path,
// then a shared-docs pass (up to 10 of them converging one Yjs room).
// Usage: node deploy/soak.mjs [baseUrl] [clients] [seconds]
// Verifies at the end that every client saw every message exactly once and
// that every doc client converged on every doc edit.
//
// "Exactly once" is checked against the ids that were actually acknowledged,
// not against each other. Comparing the clients' counts — which is all this
// did — passes whenever they are wrong together, and a fan-out bug is
// precisely the kind that is wrong for everyone at once: fifty clients each
// missing the same message have identical counts and the soak said PASSED.
// All clients join from one IP, which trips the per-IP join limiter — start
// the TARGET server with JOIN_RATE_LIMIT=1000 (a scratch instance, never the
// real event box; real crew join from distinct phone IPs and are unaffected).
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const base = process.argv[2] ?? 'http://localhost:8787'
const CLIENTS = Number(process.argv[3] ?? 50)
const SECONDS = Number(process.argv[4] ?? 60)
const EVENT_PIN = process.env.EVENT_PIN ?? '1234'
const wsBase = base.replace(/^http/, 'ws')

const stats = { sent: 0, acked: 0, dupes: 0, errors: 0 }
/** Every message the box confirmed it stored: the roll every client is called against. */
const delivered = new Set()
/** Channels a welcome said it could not fit. Unnoticed, they look like loss. */
const truncations = []

async function makeClient(i) {
  const res = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Soak ${i}`, eventPin: EVENT_PIN, personalPin: '0000' }),
  })
  if (!res.ok) throw new Error(`join failed for Soak ${i}: ${res.status}`)
  const { token } = await res.json()

  const seen = new Set()
  let channelId = null
  const ws = new WebSocket(`${wsBase}/ws`)
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, cursors: {} })))
  ws.on('error', () => stats.errors++)
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'welcome') {
      channelId = msg.channels.find((c) => c.name === 'general')?.id ?? msg.channels[0]?.id
      for (const m of msg.missed) {
        if (seen.has(m.id)) stats.dupes++
        seen.add(m.id)
      }
      // The welcome is allowed to truncate — a fresh client on a busy box
      // gets a budget and backfills the rest over REST. A soak client never
      // backfills, so any truncation makes the delivery check meaningless
      // rather than failed. Record it and say so at the end.
      if (msg.truncated?.length) truncations.push(...msg.truncated)
    }
    if (msg.type === 'ack') {
      stats.acked++
      // The id the box assigned, which is what every other client will see.
      const stored = msg.message ?? msg
      if (stored.id) delivered.add(stored.id)
    }
    if (msg.type === 'msg' || msg.type === 'ack') {
      const m = msg.message ?? msg
      if (seen.has(m.id)) stats.dupes++
      seen.add(m.id)
    }
  })

  const timer = setInterval(() => {
    if (!channelId || ws.readyState !== WebSocket.OPEN) return
    if (Math.random() < 0.15) {
      // ~1 message per client per ~7s — busy crew traffic at 50 clients
      stats.sent++
      ws.send(
        JSON.stringify({
          type: 'send',
          clientMsgId: `soak-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channelId,
          body: `soak message ${stats.sent} from ${i}`,
        })
      )
    }
  }, 1000)

  return { ws, timer, seen, token, name: `Soak ${i}` }
}

console.log(`soaking ${base} with ${CLIENTS} clients for ${SECONDS}s…`)
const clients = []
for (let i = 0; i < CLIENTS; i++) {
  clients.push(await makeClient(i))
  await new Promise((r) => setTimeout(r, 25)) // stagger joins
}

await new Promise((r) => setTimeout(r, SECONDS * 1000))
await new Promise((r) => setTimeout(r, 2000)) // drain in-flight messages

for (const c of clients) {
  clearInterval(c.timer)
  c.ws.close()
}

// Shared-docs pass: every doc client contributes one key to one room and
// must see everyone else's (the patch-sheet sync path, end to end).
const DOC_CLIENTS = Math.min(CLIENTS, 10)
const room = `patch/soak-${Date.now().toString(36)}`
const docPeers = clients.slice(0, DOC_CLIENTS).map((c, i) => {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`${wsBase}/ws/docs`, room, doc, {
    WebSocketPolyfill: WebSocket,
    params: { token: c.token },
    disableBc: true,
  })
  doc.getMap('soak').set(`client-${i}`, i)
  return { doc, provider }
})
const docsDeadline = Date.now() + 15_000
let docsConverged = false
while (Date.now() < docsDeadline && !docsConverged) {
  docsConverged = docPeers.every((p) => p.doc.getMap('soak').size === DOC_CLIENTS)
  if (!docsConverged) await new Promise((r) => setTimeout(r, 100))
}
for (const p of docPeers) p.provider.destroy()
console.log(`doc sync: ${DOC_CLIENTS} clients converged on ${room}: ${docsConverged}`)

const counts = clients.map((c) => c.seen.size)
const [min, max] = [Math.min(...counts), Math.max(...counts)]
console.log(`sent=${stats.sent} acked=${stats.acked} dupes=${stats.dupes} errors=${stats.errors}`)
console.log(`messages seen per client: min=${min} max=${max} (equal min/max = no loss)`)

// Every client against the roll of what the box actually stored, rather than
// against each other. This is the assertion the header has always claimed and
// the one that catches a fan-out bug, which by its nature shortchanges every
// client identically.
const missing = clients
  .map((c) => ({ name: c.name, lost: [...delivered].filter((id) => !c.seen.has(id)) }))
  .filter((c) => c.lost.length > 0)
for (const c of missing.slice(0, 5)) {
  console.log(`  ${c.name} never saw ${c.lost.length} of ${delivered.size} messages`)
}
if (missing.length > 5) console.log(`  …and ${missing.length - 5} more clients`)
if (truncations.length > 0) {
  // Not a failure of the box — the welcome budget doing its job — but it
  // makes the delivery check above unanswerable, so it cannot pass quietly.
  console.log(
    `  ${truncations.length} welcome(s) were truncated: a soak client never backfills, ` +
      'so run against a fresh box or with fewer seconds.'
  )
}

const ok =
  stats.dupes === 0 &&
  stats.errors === 0 &&
  stats.sent === stats.acked &&
  min === max &&
  missing.length === 0 &&
  truncations.length === 0 &&
  docsConverged
console.log(ok ? 'SOAK PASSED' : 'SOAK FAILED')
process.exit(ok ? 0 : 1)

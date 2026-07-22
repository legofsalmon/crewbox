// Soak test: N fake crew members chatting through the real join + WS path.
// Usage: node deploy/soak.mjs [baseUrl] [clients] [seconds]
// Verifies at the end that every client saw every message exactly once.
import { WebSocket } from 'ws'

const base = process.argv[2] ?? 'http://localhost:8787'
const CLIENTS = Number(process.argv[3] ?? 50)
const SECONDS = Number(process.argv[4] ?? 60)
const EVENT_PIN = process.env.EVENT_PIN ?? '1234'
const wsBase = base.replace(/^http/, 'ws')

const stats = { sent: 0, acked: 0, dupes: 0, errors: 0 }

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
    }
    if (msg.type === 'ack') stats.acked++
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
        }),
      )
    }
  }, 1000)

  return { ws, timer, seen, name: `Soak ${i}` }
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

const counts = clients.map((c) => c.seen.size)
const [min, max] = [Math.min(...counts), Math.max(...counts)]
console.log(`sent=${stats.sent} acked=${stats.acked} dupes=${stats.dupes} errors=${stats.errors}`)
console.log(`messages seen per client: min=${min} max=${max} (equal min/max = no loss)`)

const ok = stats.dupes === 0 && stats.errors === 0 && stats.sent === stats.acked && min === max
console.log(ok ? 'SOAK PASSED' : 'SOAK FAILED')
process.exit(ok ? 0 : 1)

#!/usr/bin/env node
// Listen to a lighting network and say what is on it. Read-only, always.
//
// This ships nothing into the box. It exists so that crewbox's Art-Net and
// sACN parsers can be written against bytes off a real rig instead of bytes
// invented from the same notes the parser was written from — a parser and its
// tests can agree with each other perfectly and still be wrong about the wire.
//
// It is also useful on its own: point it at a switch port and it answers "is
// Art-Net even reaching this thing" before crewbox is involved at all.
//
//   node scripts/dmx-sniff.mjs                      both protocols, all interfaces
//   node scripts/dmx-sniff.mjs --iface 2.0.0.10     join multicast on that NIC
//   node scripts/dmx-sniff.mjs --universes 1-8      which sACN groups to join
//   node scripts/dmx-sniff.mjs --dump ./capture     also write the raw packets
//   node scripts/dmx-sniff.mjs --seconds 30         stop after 30s
//
// The decoding here is deliberately its own small implementation rather than
// an import of the server's. Two independent readings of a spec disagreeing
// is a signal worth having, and --dump is the part that actually matters:
// those raw bytes become the parser's test fixtures.

import dgram from 'node:dgram'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'

const ARTNET_PORT = 6454
const SACN_PORT = 5568
const ACN_PID = Buffer.from('ASC-E1.17\0\0\0', 'latin1')

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? true)
}
const has = (name) => argv.includes(`--${name}`)

if (has('help')) {
  console.log(
    [
      'Usage: node scripts/dmx-sniff.mjs [options]',
      '',
      '  --iface <ip>        interface IP to join sACN multicast groups on',
      '  --universes <list>  sACN universes, e.g. 1-8,101 (default 1-16)',
      '  --artnet-only       skip sACN',
      '  --sacn-only         skip Art-Net',
      '  --dump <dir>        write raw packets, one file per source+universe',
      '  --seconds <n>       exit after n seconds',
      '  --slots <n>         how many DMX slots to print (default 8)',
      '',
      'Read-only: this script never transmits DMX.',
    ].join('\n')
  )
  process.exit(0)
}

/** "1-8,101" → [1,2,3,4,5,6,7,8,101] */
function parseUniverses(spec) {
  const out = new Set()
  for (const part of String(spec).split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      for (let u = from; u <= to && u - from < 512; u++) out.add(u)
    } else if (/^\d+$/.test(part.trim())) {
      out.add(Number(part.trim()))
    }
  }
  return [...out].filter((u) => u >= 1 && u <= 63999)
}

const ifaceIp = flag('iface')
const universes = parseUniverses(flag('universes', '1-16'))
const dumpDir = flag('dump')
const seconds = Number(flag('seconds', 0)) || 0
const slotsToShow = Number(flag('slots', 8)) || 8
const wantArtNet = !has('sacn-only')
const wantSacn = !has('artnet-only')

if (dumpDir) mkdirSync(dumpDir, { recursive: true })

// ------------------------------------------------------------------ decoding

/** ArtDmx, or null. Deliberately lenient: this is a diagnostic, not a receiver. */
function decodeArtNet(buf, fromIp) {
  if (buf.length < 12) return null
  if (buf.toString('latin1', 0, 8) !== 'Art-Net\0') return null
  const opcode = buf.readUInt16LE(8)
  if (opcode === 0x2100) {
    // ArtPollReply. Names are cosmetic here; read them defensively.
    const cstr = (start, len) => {
      if (buf.length < start + len) return ''
      const raw = buf.subarray(start, start + len)
      const end = raw.indexOf(0)
      return raw.toString('latin1', 0, end === -1 ? raw.length : end).trim()
    }
    return { kind: 'pollReply', fromIp, shortName: cstr(26, 18), longName: cstr(44, 64) }
  }
  // ArtSync. No payload and no port address — from here on every node on the
  // network buffers ArtDmx rather than outputting it, until four seconds pass
  // without another one. Levels on the wire stop being levels on stage.
  if (opcode === 0x5200) return { kind: 'sync', protocol: 'artnet', fromIp }
  if (opcode !== 0x5000 || buf.length < 18) return null
  const protVer = buf.readUInt16BE(10)
  const portAddress = buf.readUInt16LE(14) & 0x7fff
  const declared = buf.readUInt16BE(16)
  const slots = buf.subarray(18, 18 + Math.min(declared, buf.length - 18))
  return {
    kind: 'dmx',
    protocol: 'artnet',
    fromIp,
    protVer,
    universe: portAddress,
    sequence: buf[12],
    declaredLength: declared,
    slots,
  }
}

/**
 * An E1.31 data packet, or null.
 *
 * Deliberately laxer than `server/src/dmx/sacn.ts`, which additionally checks
 * the postamble and the DMP layer's addressing fields. A sniffer's job is to
 * show what is on the wire, including things the box itself would ignore —
 * "the sniffer sees it and crewbox doesn't" is a useful thing to be able to
 * discover, not a contradiction to be tidied away.
 */
function decodeSacn(buf, fromIp) {
  if (buf.length < 47) return null
  if (buf.readUInt16BE(0) !== 0x0010) return null
  if (!buf.subarray(4, 16).equals(ACN_PID)) return null

  // Synchronization packets share only the root layer and diverge at its
  // vector: 0x08 rather than 0x04, with 0x01 under it. Worth showing because
  // data carrying a sync address is only actually held by a receiver that is
  // also seeing this stream (E1.31 §6.2.4.1) — "the desk asks for sync and
  // nothing is sending it" is a fault you can only spot by watching for both.
  if (buf.readUInt32BE(18) === 0x00000008 && buf.readUInt32BE(40) === 0x00000001) {
    return {
      kind: 'sync',
      protocol: 'sacn',
      fromIp,
      cid: buf.subarray(22, 38).toString('hex'),
      syncAddress: buf.readUInt16BE(45),
      sequence: buf[44],
    }
  }

  if (buf.length < 126) return null
  if (buf.readUInt32BE(18) !== 0x00000004) return null
  if (buf.readUInt32BE(40) !== 0x00000002) return null
  if (buf[117] !== 0x02) return null
  const startCode = buf[125]
  const count = buf.readUInt16BE(123)
  const slotCount = Math.max(0, Math.min(count - 1, buf.length - 126))
  const nameRaw = buf.subarray(44, 108)
  const nameEnd = nameRaw.indexOf(0)
  const options = buf[112]
  return {
    kind: 'dmx',
    protocol: 'sacn',
    fromIp,
    cid: buf.subarray(22, 38).toString('hex'),
    sourceName: nameRaw.toString('utf8', 0, nameEnd === -1 ? nameRaw.length : nameEnd).trim(),
    priority: buf[108],
    sequence: buf[111],
    // Bit 7 is preview, bit 6 is terminated. Getting these the wrong way round
    // makes a live rig look silent, which is the mistake this script exists
    // to stop anyone shipping.
    preview: (options & 0x80) !== 0,
    terminated: (options & 0x40) !== 0,
    // Bit 5. Clear means a receiver that loses sync freezes on its last look
    // rather than carrying on — so a rig can be stuck while the desk is fine.
    forceSync: (options & 0x20) !== 0,
    syncAddress: buf.readUInt16BE(109),
    universe: buf.readUInt16BE(113),
    startCode,
    declaredLength: count,
    slots: buf.subarray(126, 126 + slotCount),
  }
}

// ------------------------------------------------------------------ reporting

/** key → { packets, lastPrinted, lastSeen, sample } */
const seen = new Map()
const dumped = new Set()
let total = 0

const label = (p) =>
  p.protocol === 'sacn'
    ? `sACN  u${String(p.universe).padStart(5)}  ${p.sourceName || p.cid.slice(0, 8)}  pri ${p.priority}`
    : `Art-Net u${String(p.universe).padStart(5)}  ${p.fromIp}`

function report(packet) {
  total++
  const key = `${packet.protocol}:${packet.universe}:${packet.cid ?? packet.fromIp}`
  const now = Date.now()
  let entry = seen.get(key)
  if (!entry) {
    entry = { packets: 0, lastPrinted: 0, firstSeen: now }
    seen.set(key, entry)
    console.log(`\n+ ${label(packet)}`)
  }
  entry.packets++
  entry.lastSeen = now

  if (dumpDir && !dumped.has(key)) {
    dumped.add(key)
    const safe = key.replace(/[^a-z0-9]+/gi, '-')
    writeFileSync(join(dumpDir, `${safe}.bin`), packet.raw)
    console.log(`  captured raw packet → ${safe}.bin (${packet.raw.length} bytes)`)
  }

  // One line per source per second: a rig at 44 Hz would otherwise be a wall.
  if (now - entry.lastPrinted < 1000) return
  // No rate until there is a window worth dividing by — one packet arriving
  // in the first millisecond is not 1000/s, and a wrong number on site is
  // worse than no number.
  const elapsed = now - entry.firstSeen
  const rate = elapsed >= 500 ? `${Math.round((entry.packets * 1000) / elapsed)}/s` : '…/s'
  const head = [...packet.slots.subarray(0, slotsToShow)].join(' ')
  const lit = [...packet.slots].filter((v) => v > 0).length
  const flags = [
    packet.preview ? 'PREVIEW' : '',
    packet.terminated ? 'TERMINATED' : '',
    packet.syncAddress ? `SYNC=u${packet.syncAddress}` : '',
    packet.syncAddress && packet.forceSync ? 'FORCE-SYNC' : '',
    packet.startCode !== undefined && packet.startCode !== 0
      ? `start=0x${packet.startCode.toString(16)}`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
  console.log(
    `  ${label(packet)}  ${rate}  ${packet.slots.length} slots, ${lit} lit  [${head}${
      packet.slots.length > slotsToShow ? ' …' : ''
    }]${flags ? ` ${flags}` : ''}`
  )
  entry.lastPrinted = now
}

/** sync stream key → { packets, lastPrinted, firstSeen } */
const syncSeen = new Map()

/**
 * A synchronisation stream, reported the same way a data stream is.
 *
 * Rate matters more than content here: a stream at 44/s is doing its job, and
 * one that appears and then stops is the thing that leaves a rig frozen.
 */
function reportSync(protocol, where, id) {
  const key = `${protocol}:sync:${where}:${id}`
  const now = Date.now()
  let entry = syncSeen.get(key)
  if (!entry) {
    entry = { packets: 0, lastPrinted: 0, firstSeen: now }
    syncSeen.set(key, entry)
    console.log(`\n+ ${protocol} SYNC ${where}  ${id.slice(0, 8)}`)
  }
  entry.packets++
  if (now - entry.lastPrinted < 1000) return
  const elapsed = now - entry.firstSeen
  const rate = elapsed >= 500 ? `${Math.round((entry.packets * 1000) / elapsed)}/s` : '…/s'
  console.log(
    `  ${protocol} SYNC ${where}  ${rate}  (data on these universes is held until each one)`
  )
  entry.lastPrinted = now
}

// ------------------------------------------------------------------- sockets

/**
 * A receive-only socket. `send` is replaced with a thrower before the socket
 * is ever used, so this cannot transmit onto a show network even by mistake.
 */
function receiveOnlySocket() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket.send = () => {
    throw new Error('dmx-sniff is read-only and must never transmit')
  }
  return socket
}

const sockets = []

if (wantArtNet) {
  const socket = receiveOnlySocket()
  socket.on('error', (err) => console.error(`Art-Net socket: ${err.message}`))
  socket.on('message', (buf, rinfo) => {
    const packet = decodeArtNet(buf, rinfo.address)
    if (!packet) return
    if (packet.kind === 'pollReply') {
      console.log(`\n+ Art-Net node ${packet.fromIp}: ${packet.longName || packet.shortName}`)
      return
    }
    if (packet.kind === 'sync') {
      reportSync('Art-Net', packet.fromIp, packet.fromIp)
      return
    }
    report({ ...packet, raw: buf })
  })
  socket.bind(ARTNET_PORT, () => {
    console.log(`Art-Net: listening on 0.0.0.0:${ARTNET_PORT} (broadcast)`)
  })
  sockets.push(socket)
}

if (wantSacn) {
  const socket = receiveOnlySocket()
  socket.on('error', (err) => console.error(`sACN socket: ${err.message}`))
  socket.on('message', (buf, rinfo) => {
    const packet = decodeSacn(buf, rinfo.address)
    if (!packet) return
    if (packet.kind === 'sync') {
      reportSync('sACN', `u${packet.syncAddress}`, packet.cid)
      return
    }
    report({ ...packet, raw: buf })
  })
  // Bind 0.0.0.0, never a unicast address: binding to a specific interface IP
  // stops multicast arriving at all on Linux.
  socket.bind(SACN_PORT, () => {
    const failed = []
    for (const universe of universes) {
      const group = `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`
      try {
        if (ifaceIp) socket.addMembership(group, ifaceIp)
        else socket.addMembership(group)
      } catch (err) {
        failed.push(`${universe} (${err.code ?? err.message})`)
      }
    }
    console.log(
      `sACN: listening on 0.0.0.0:${SACN_PORT}, joined ${universes.length - failed.length}/${universes.length} groups` +
        (ifaceIp ? ` via ${ifaceIp}` : ' via the default route')
    )
    if (failed.length > 0) {
      console.error(`sACN: could NOT join ${failed.join(', ')}`)
      console.error(
        '  Linux allows 20 memberships per socket by default — see net.ipv4.igmp_max_memberships.'
      )
    }
  })
  sockets.push(socket)
}

// --------------------------------------------------------------------- exit

const addresses = Object.entries(networkInterfaces())
  .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
  .filter((a) => a.family === 'IPv4' && !a.internal)
  .map((a) => `${a.name} ${a.address}`)
console.log(`Interfaces: ${addresses.join(', ') || 'none found'}`)
if (!ifaceIp && wantSacn && addresses.length > 1) {
  console.log('More than one interface — pass --iface <ip> if sACN stays silent.')
}
console.log('Read-only. Nothing is transmitted. Ctrl-C to stop.\n')

function summary() {
  console.log(`\n--- ${total} packets from ${seen.size} source/universe pairs ---`)
  for (const [key, entry] of seen) {
    const secs = (entry.lastSeen - entry.firstSeen) / 1000
    const rate = secs >= 0.5 ? `${Math.round(entry.packets / secs)}/s` : 'too brief to rate'
    console.log(`  ${key}  ${entry.packets} packets  ${rate}`)
  }
  if (dumpDir) console.log(`Raw packets in ${dumpDir}`)
  if (total === 0) {
    console.log('\nNothing arrived. Worth checking, in order:')
    console.log('  - is this machine on the lighting network (right NIC, right VLAN)?')
    console.log('  - for sACN, is --iface set to that NIC on a multi-homed machine?')
    console.log('  - is the switch doing IGMP snooping with no querier?')
    console.log('  - is a host firewall dropping inbound UDP 6454/5568?')
    console.log('  - is the console unicasting Art-Net to specific nodes only?')
  }
  for (const socket of sockets) socket.close()
}

process.on('SIGINT', () => {
  summary()
  process.exit(0)
})
if (seconds > 0) {
  setTimeout(() => {
    summary()
    process.exit(0)
  }, seconds * 1000).unref?.()
}

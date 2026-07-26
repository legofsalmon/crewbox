import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket } from 'ws'

/**
 * Voice signalling, proxied through the box's own port.
 *
 * A page served over https:// cannot open a ws:// socket — browsers block it
 * as mixed content — so the moment the box gets a certificate, pointing crew
 * straight at the SFU on :7880 would break voice for every browser. The
 * alternatives are giving the SFU its own copy of the certificate, or putting
 * its signalling behind the box. Behind the box is better: one certificate,
 * one port, one hole in the venue firewall, and the URL works out the same
 * over http and https.
 *
 * Only *signalling* comes through here. The actual audio is WebRTC over UDP
 * straight to the SFU, already encrypted with DTLS-SRTP, and would gain
 * nothing but latency from being relayed.
 */

/** Path the client is pointed at; the LiveKit SDK appends /rtc to it. */
export const VOICE_PROXY_PATH = '/livekit'

const stripPrefix = (url: string): string => {
  const rest = url.slice(VOICE_PROXY_PATH.length)
  return rest.startsWith('/') ? rest : `/${rest}`
}

/**
 * Proxy a plain HTTP call to the SFU. The LiveKit SDK makes one of these
 * (`/rtc/validate`) before it opens the socket, so missing it fails the
 * connection with a confusing error rather than an obvious one.
 */
export function proxyVoiceHttp(req: IncomingMessage, res: ServerResponse, port: number): void {
  const target = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: stripPrefix(req.url ?? '/'),
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers)
      upstream.pipe(res)
    }
  )
  target.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('voice server unreachable')
  })
  req.pipe(target)
}

/**
 * Proxy the signalling WebSocket. Opens a socket to the SFU and pipes frames
 * both ways, closing each side when the other goes.
 */
export function proxyVoiceSocket(client: WebSocket, url: string, port: number): void {
  const upstream = new WebSocket(`ws://127.0.0.1:${port}${stripPrefix(url)}`)
  const pending: (string | Buffer)[] = []

  // The client can start talking before the upstream handshake finishes;
  // dropping those frames loses the join and the crew member never connects.
  client.on('message', (data: Buffer, isBinary: boolean) => {
    const frame = isBinary ? data : data.toString()
    if (upstream.readyState === WebSocket.OPEN) upstream.send(frame)
    else pending.push(frame)
  })

  upstream.on('open', () => {
    for (const frame of pending.splice(0)) upstream.send(frame)
  })
  upstream.on('message', (data: Buffer, isBinary: boolean) => {
    if (client.readyState === WebSocket.OPEN) client.send(isBinary ? data : data.toString())
  })

  const close = (socket: WebSocket) => () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
  }
  upstream.on('close', close(client))
  upstream.on('error', close(client))
  client.on('close', close(upstream))
  client.on('error', close(upstream))
}

/** True when this upgrade belongs to the voice proxy. */
export const isVoiceUpgrade = (pathname: string): boolean =>
  pathname === VOICE_PROXY_PATH || pathname.startsWith(`${VOICE_PROXY_PATH}/`)

/** Reject an upgrade that arrived when voice isn't running. */
export function rejectVoiceUpgrade(socket: Duplex): void {
  socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
  socket.destroy()
}

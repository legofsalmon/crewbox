import { useCallback, useEffect, useRef, useState } from 'react'
import type { NetmapDevice, NetmapLane, NetmapPayload, NetmapWifi } from '@crewbox/shared'
import { openSession } from '../../lib/sessions.ts'
import DrawerButton from '../../shell/DrawerButton.tsx'
import { reportAge } from './model/age.ts'
import {
  STATE_WORDS,
  deviceTitle,
  fetchNetmap,
  laneSummary,
  missingReadings,
  querierWords,
  signalText,
  signalWord,
  sinceWords,
  splitDevices,
} from './model/netmap.ts'
import styles from './NetworkMap.module.scss'

/**
 * The network map: what the box can say is on each network it has a leg
 * on, and what has gone quiet.
 *
 * One job: who is here, per network. Grades and fixes stay on the audit
 * pane beside it. Everything on this view was overheard or read from the
 * box's own tables, so opening it sends nothing; it polls the box every
 * ten seconds while it is open and visible, like the audit.
 *
 * Healthy is quiet: a device that is heard gets a neutral dot, and only one
 * that has gone quiet (amber) or stopped answering (red) draws the eye.
 * Every dot has its words beside it.
 */

const POLL_MS = 10_000
/** Rows shown per network before the healthy ones fold away. */
const ROWS = 12

export default function NetworkMap() {
  const [map, setMap] = useState<NetmapPayload | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await fetchNetmap(openSession() ?? '')
      if (mine !== generation.current) return
      setMap(next)
      setNow(Date.now())
      setError('')
    } catch (err) {
      // Keep the last map on screen and say the refresh is waiting.
      if (mine === generation.current)
        setError(err instanceof Error ? err.message : 'map unavailable')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(tick)
  }, [])

  const missing = map ? missingReadings(map.readings) : []

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <DrawerButton />
        <h1 className={styles.title}>Network map</h1>
        {map && (
          <span className={styles.age} title={new Date(map.generatedAt).toISOString()}>
            {reportAge(map.generatedAt, now)}
          </span>
        )}
      </header>

      {error && <p className={styles.note}>Waiting for the box: {error}</p>}
      {!map && !error && <p className={styles.note}>Asking the box what it can see…</p>}

      {map && (
        <div className={styles.body}>
          <p className={styles.lede}>
            What the box has heard or talked to on each network. A device that never announces
            itself and never talks to the box won’t be here, so this is never the whole network.
          </p>
          <div className={styles.lanes}>
            {map.lanes.map((lane) => (
              <Lane key={lane.id} lane={lane} now={now} />
            ))}
          </div>
          <Wifi wifi={map.wifi} />
          {(missing.length > 0 || map.overflow > 0) && (
            <section className={styles.footnote} aria-label="Not read on this box">
              <h2 className={styles.footHead}>Not read on this box</h2>
              <ul>
                {missing.map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {map.overflow > 0 && (
                  <li>
                    {map.overflow} address{map.overflow === 1 ? '' : 'es'} refused because a list
                    was full. That many senders usually means something on the network is
                    misbehaving.
                  </li>
                )}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function Lane({ lane, now }: { lane: NetmapLane; now: number }) {
  const [all, setAll] = useState(false)
  const { shown, folded } = all
    ? { shown: lane.devices, folded: 0 }
    : splitDevices(lane.devices, ROWS)
  const querier = querierWords(lane.querier)
  const adapter = lane.adapter
  return (
    <section className={styles.lane} aria-label={`${lane.label} network`}>
      <header className={styles.laneHead}>
        <h2 className={styles.laneTitle}>{lane.label}</h2>
        <span className={styles.summary}>{laneSummary(lane)}</span>
      </header>
      <dl className={styles.facts}>
        <div>
          <dt>Adapter</dt>
          <dd className={adapter ? styles.mono : undefined}>
            {adapter
              ? [
                  adapter.name,
                  adapter.cidr,
                  adapter.speedMbps ? `${adapter.speedMbps} Mb/s` : '',
                  adapter.up === false ? 'link down' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Whichever the system picks'}
          </dd>
        </div>
        {lane.switchPort && (
          <div>
            <dt>Plugged into</dt>
            <dd>
              {lane.switchPort.system || 'A switch'}, port{' '}
              <span className={styles.mono}>{lane.switchPort.port}</span>
              {lane.switchPort.description && lane.switchPort.description !== lane.switchPort.port
                ? ` (${lane.switchPort.description})`
                : ''}
            </dd>
          </div>
        )}
        {querier && lane.id !== 'crew' && (
          <div>
            <dt>Multicast</dt>
            <dd>{querier}</dd>
          </div>
        )}
      </dl>
      {shown.length > 0 && (
        <ul className={styles.devices}>
          {shown.map((device) => (
            <Device key={device.key} device={device} now={now} />
          ))}
        </ul>
      )}
      {folded > 0 && (
        <button className={styles.more} onClick={() => setAll(true)}>
          Show {folded} more heard
        </button>
      )}
      {lane.note && <p className={styles.laneNote}>{lane.note}</p>}
    </section>
  )
}

function Device({ device, now }: { device: NetmapDevice; now: number }) {
  const since = device.state === 'quiet' || device.state === 'silent'
  const ago = since ? sinceWords(device.lastSeen, now) : ''
  return (
    <li className={`${styles.device} ${styles[device.state] ?? ''}`}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.deviceText}>
        <span className={styles.deviceName}>{deviceTitle(device)}</span>
        <span className={styles.meta}>
          {[device.roles.join(', '), device.name && device.address, device.mac]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className={styles.state}>
        {STATE_WORDS[device.state]}
        {ago && <span className={styles.ago}> · {ago}</span>}
      </span>
    </li>
  )
}

function Wifi({ wifi }: { wifi: NetmapWifi }) {
  if (!wifi.available) return null
  const crewSeen = wifi.networks.some((n) => n.crew)
  return (
    <section className={styles.lane} aria-label="Wi-Fi around the box">
      <header className={styles.laneHead}>
        <h2 className={styles.laneTitle}>Wi-Fi around the box</h2>
        <span className={styles.summary}>
          {wifi.networks.length} network{wifi.networks.length === 1 ? '' : 's'} on{' '}
          <span className={styles.mono}>{wifi.adapter}</span>
        </span>
      </header>
      <p className={styles.laneNote}>
        From the scans the system makes by itself: the box never starts one.
        {wifi.crewSsid && !crewSeen && ` The crew Wi-Fi, ${wifi.crewSsid}, isn’t among them.`}
      </p>
      {wifi.channels.length > 0 && (
        <ul className={styles.channels} aria-label="Channels in use">
          {wifi.channels.map((c) => (
            <li key={`${c.band} ${c.channel}`} className={styles.channel}>
              <span className={styles.channelName}>
                Ch {c.channel} <span className={styles.ago}>{c.band}</span>
              </span>
              <span className={styles.meta}>
                {c.networks} network{c.networks === 1 ? '' : 's'}
                {c.busyPct != null && ` · ${c.busyPct}% busy`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className={styles.devices}>
        {wifi.networks.map((n) => (
          <li
            key={`${n.ssid} ${n.bssidTail}`}
            className={`${styles.device} ${styles.wifiRow} ${n.crew && /weak/i.test(signalWord(n)) ? styles.weak : ''}`}
          >
            <span className={styles.deviceText}>
              <span className={styles.deviceName}>
                {n.ssid || 'Hidden network'}
                {n.crew && <span className={styles.crewTag}>Crew Wi-Fi</span>}
              </span>
              <span className={styles.meta}>
                {[
                  `Ch ${n.channel} ${n.band}`,
                  n.security,
                  n.stations != null ? `${n.stations} on it` : '',
                  n.utilisationPct != null ? `${n.utilisationPct}% busy` : '',
                  `…${n.bssidTail}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className={styles.state}>
              {signalWord(n)} <span className={styles.ago}>{signalText(n)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

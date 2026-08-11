import { useEffect, useState } from 'react'
import { useStore } from './store.ts'
import { guardStrayFileDrops } from './lib/useFileDrop.ts'
import Join from './components/Join.tsx'
import Sidebar from './components/Sidebar.tsx'
import ChannelView from './components/ChannelView.tsx'
import SearchOverlay from './components/SearchOverlay.tsx'
import AdminPanel from './components/AdminPanel.tsx'
import AdminUnlock from './components/AdminUnlock.tsx'
import OnAirBar from './components/OnAirBar.tsx'
import VoiceBar from './components/VoiceBar.tsx'
import AudioSettings from './components/AudioSettings.tsx'
import FileDetail from './components/FileDetail.tsx'
import IosInstallTip from './components/IosInstallTip.tsx'
import ServerUnreachable, { Connecting } from './components/ServerUnreachable.tsx'
import ConnectionHelp from './components/ConnectionHelp.tsx'
import { connectionScreen, STUCK_AFTER_MS } from './lib/connscreen.ts'
import { registerShortcut } from './shell/keys.ts'
import { allModules } from './shell/registry.ts'
import { enabledModules } from './shell/modules.ts'

export default function App() {
  const phase = useStore((s) => s.phase)
  const boot = useStore((s) => s.boot)

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A file dropped anywhere without a listener makes the browser *open* it,
  // throwing away the running app — mid-shift, with unsent messages still in
  // the outbox. Missing a drop target should do nothing at all.
  useEffect(() => guardStrayFileDrops(), [])

  if (phase === 'boot') return <div className="boot-screen" />
  if (phase === 'join') return <Join />
  return <Shell />
}

/** The main pane: an active module's view, else chat's channel view. */
function Main() {
  const activeChannelId = useStore((s) => s.activeChannelId)
  const activeModuleId = useStore((s) => s.activeModuleId)
  const activeModuleSubpath = useStore((s) => s.activeModuleSubpath)
  const configModules = useStore((s) => s.config.modules)

  if (activeModuleId) {
    const module = enabledModules(allModules, configModules).find((m) => m.id === activeModuleId)
    if (module?.Main) return <module.Main subpath={activeModuleSubpath} />
    return <div className="empty-state">This module isn’t available on this server</div>
  }
  if (activeChannelId) return <ChannelView channelId={activeChannelId} />
  return <div className="empty-state">Pick a channel to start talking</div>
}

function Shell() {
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const searchOpen = useStore((s) => s.searchOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const adminOpen = useStore((s) => s.adminOpen)
  const adminToken = useStore((s) => s.adminToken)
  const audioSettingsOpen = useStore((s) => s.audioSettingsOpen)
  const fileDetail = useStore((s) => s.fileDetail)
  const connection = useStore((s) => s.connection)
  const hasConnected = useStore((s) => s.hasConnected)
  const hasCache = useStore((s) => Object.keys(s.channels).length > 0)
  const toasts = useStore((s) => s.toasts)
  const updateReady = useStore((s) => s.updateReady)
  const applyUpdate = useStore((s) => s.applyUpdate)

  // A returning user gets the app from cache and a thin banner, which is
  // right for a roam or a box restart and useless when the box has genuinely
  // gone. After a while the banner offers to explain itself.
  //
  // Keyed on `online` rather than on `connection`: a real outage flips
  // repeatedly between connecting and offline as the socket retries, and a
  // timer restarted on every one of those would never fire.
  const online = connection === 'online'
  const [stuck, setStuck] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  useEffect(() => {
    if (online) {
      setStuck(false)
      setHelpOpen(false)
      return
    }
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS)
    return () => clearTimeout(timer)
  }, [online])

  useEffect(
    () =>
      registerShortcut({
        key: 'k',
        mod: true,
        handler: () => setSearchOpen(!useStore.getState().searchOpen),
      }),
    [setSearchOpen]
  )

  // Before any content exists, show a calm connecting / recovery screen instead
  // of an empty shell. Returning users (cache or a prior connect) skip this.
  const screen = connectionScreen({ connection, hasConnected, hasCache })
  if (screen === 'unreachable') return <ServerUnreachable />
  if (screen === 'connecting') return <Connecting />

  return (
    <div className="app">
      {connection !== 'online' &&
        (stuck ? (
          // Once it stops being a blip the banner becomes the way in to an
          // explanation, rather than repeating itself indefinitely. Still a
          // banner: the app underneath keeps working from cache, and taking
          // that away would treat offline as a fault.
          <button
            className={`conn-banner conn-${connection} conn-banner-stuck`}
            onClick={() => setHelpOpen(true)}
          >
            {connection === 'connecting' ? 'Still connecting…' : 'Still offline…'}{' '}
            <span className="conn-banner-why">Why?</span>
          </button>
        ) : (
          <div className={`conn-banner conn-${connection}`}>
            {connection === 'connecting'
              ? 'Connecting…'
              : 'Offline — messages you send will deliver when the connection returns'}
          </div>
        ))}
      {helpOpen && <ConnectionHelp onClose={() => setHelpOpen(false)} />}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((toast) => (
            <div key={toast.id} className={`flash flash-${toast.kind}`}>
              {toast.message}
            </div>
          ))}
        </div>
      )}
      {updateReady && (
        <button className="update-pill" onClick={applyUpdate}>
          <span>New version available</span>
          <strong>Reload</strong>
        </button>
      )}
      <OnAirBar />
      <VoiceBar />
      <div className={`layout ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar />
        {sidebarOpen && <div className="backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main">
          <Main />
        </main>
      </div>
      {searchOpen && <SearchOverlay />}
      {/* The cog is visible to everyone; the password is what gates the
          panel, so the gate lives here rather than around the button. */}
      {adminOpen && (adminToken ? <AdminPanel /> : <AdminUnlock />)}
      {audioSettingsOpen && <AudioSettings />}
      {fileDetail && <FileDetail />}
      <IosInstallTip />
    </div>
  )
}

import { useEffect } from 'react'
import { useStore } from './store.ts'
import Join from './components/Join.tsx'
import Sidebar from './components/Sidebar.tsx'
import ChannelView from './components/ChannelView.tsx'
import SearchOverlay from './components/SearchOverlay.tsx'
import AdminPanel from './components/AdminPanel.tsx'
import VoiceBar from './components/VoiceBar.tsx'
import AudioSettings from './components/AudioSettings.tsx'
import IosInstallTip from './components/IosInstallTip.tsx'
import ServerUnreachable, { Connecting } from './components/ServerUnreachable.tsx'
import { connectionScreen } from './lib/connscreen.ts'

export default function App() {
  const phase = useStore((s) => s.phase)
  const boot = useStore((s) => s.boot)

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (phase === 'boot') return <div className="boot-screen" />
  if (phase === 'join') return <Join />
  return <Chat />
}

function Chat() {
  const activeChannelId = useStore((s) => s.activeChannelId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const searchOpen = useStore((s) => s.searchOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const adminOpen = useStore((s) => s.adminOpen)
  const audioSettingsOpen = useStore((s) => s.audioSettingsOpen)
  const connection = useStore((s) => s.connection)
  const hasConnected = useStore((s) => s.hasConnected)
  const hasCache = useStore((s) => Object.keys(s.channels).length > 0)
  const flash = useStore((s) => s.flash)
  const updateReady = useStore((s) => s.updateReady)
  const applyUpdate = useStore((s) => s.applyUpdate)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(!useStore.getState().searchOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  // Before any content exists, show a calm connecting / recovery screen instead
  // of an empty shell. Returning users (cache or a prior connect) skip this.
  const screen = connectionScreen({ connection, hasConnected, hasCache })
  if (screen === 'unreachable') return <ServerUnreachable />
  if (screen === 'connecting') return <Connecting />

  return (
    <div className="app">
      {connection !== 'online' && (
        <div className={`conn-banner conn-${connection}`}>
          {connection === 'connecting'
            ? 'Connecting…'
            : 'Offline — messages you send will deliver when the connection returns'}
        </div>
      )}
      {flash && <div className="flash">{flash}</div>}
      {updateReady && (
        <button className="update-pill" onClick={applyUpdate}>
          <span>New version available</span>
          <strong>Reload</strong>
        </button>
      )}
      <VoiceBar />
      <div className={`layout ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar />
        {sidebarOpen && <div className="backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main">
          {activeChannelId ? (
            <ChannelView channelId={activeChannelId} />
          ) : (
            <div className="empty-state">Pick a channel to start talking</div>
          )}
        </main>
      </div>
      {searchOpen && <SearchOverlay />}
      {adminOpen && <AdminPanel />}
      {audioSettingsOpen && <AudioSettings />}
      <IosInstallTip />
    </div>
  )
}

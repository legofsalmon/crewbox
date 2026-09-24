import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useStore } from './store.ts'
import { guardStrayFileDrops } from './lib/useFileDrop.ts'
import { currentFileOffer, subscribeFileOffer } from './lib/download.ts'
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
import FileOfferBar from './components/FileOfferBar.tsx'
import AlertBanner from './components/AlertBanner.tsx'
import IosInstallTip from './components/IosInstallTip.tsx'
import ServerUnreachable, { Connecting } from './components/ServerUnreachable.tsx'
import ConnectionHelp from './components/ConnectionHelp.tsx'
import Boxes from './components/Boxes.tsx'
import MoveWorkOffer from './components/MoveWork.tsx'
import { connectionScreen, elsewhereView, STUCK_AFTER_MS } from './lib/connscreen.ts'
import { useBoxSearch } from './lib/discovery.ts'
import { useFollowBoxes } from './lib/follow.ts'
import { isNative, serverLabel } from './lib/server.ts'
import DrawerButton from './shell/DrawerButton.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import FeedbackDialog from './components/FeedbackDialog.tsx'
import { APP_VERSION } from './lib/pwa.ts'
import { flushDeviceOutbox, sendCrash } from './lib/reports.ts'
import { sessionToken } from './store.ts'
import { registerShortcut } from './shell/keys.ts'
import { allModules } from './shell/registry.ts'
import { enabledModules } from './shell/modules.ts'

export default function App() {
  const phase = useStore((s) => s.phase)
  const boot = useStore((s) => s.boot)
  const boxesOpen = useStore((s) => s.boxesOpen)

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A file dropped anywhere without a listener makes the browser *open* it,
  // throwing away the running app — mid-shift, with unsent messages still in
  // the outbox. Missing a drop target should do nothing at all.
  useEffect(() => guardStrayFileDrops(), [])

  /*
   * `?admin` opens the panel.
   *
   * The one caller is the tray and menu-bar helper's "Update available" item.
   * Before the box could update itself that opened a download page, which is
   * now the wrong answer — the update happens here. The helpers know a URL and
   * nothing else about the app, so a query parameter is the whole interface.
   *
   * Stripped from the address bar immediately, so a reload or a shared link
   * does not keep reopening a panel somebody deliberately closed.
   */
  useEffect(() => {
    if (phase !== 'chat') return
    const url = new URL(window.location.href)
    if (!url.searchParams.has('admin')) return
    url.searchParams.delete('admin')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    useStore.getState().setAdminOpen(true)
  }, [phase])

  if (phase === 'boot') return <div className="boot-screen" />
  // Over whichever screen it was opened from: the join form, the one saying
  // the box cannot be reached, or the app.
  return (
    <>
      {phase === 'join' ? <Join /> : <Shell />}
      {boxesOpen && <Boxes />}
      <MoveWorkOffer />
    </>
  )
}

/**
 * A pane with nothing in it, and a way out of it.
 *
 * The way out is the point. Navigating to a module closes the drawer, so
 * these two panes — the only ones in the app that are not a module's own
 * view — stranded a phone user inside them: no header, no drawer button,
 * and the browser back button is not a UI. A deep link to a module the box
 * has switched off was a dead end you had to reload out of.
 */
function EmptyPane({ children }: { children: ReactNode }) {
  return (
    <div className="empty-pane">
      <header className="empty-pane-head">
        <DrawerButton />
      </header>
      <div className="empty-state">{children}</div>
    </div>
  )
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
    return (
      <EmptyPane>
        This module isn’t available on this server. Open the menu to go back to chat.
      </EmptyPane>
    )
  }
  if (activeChannelId) return <ChannelView channelId={activeChannelId} />
  return <EmptyPane>Pick a channel to start talking</EmptyPane>
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
  const hasFailed = useStore((s) => s.hasFailed)
  const hasCache = useStore((s) => Object.keys(s.channels).length > 0)
  const toasts = useStore((s) => s.toasts)
  const fileOffer = useSyncExternalStore(subscribeFileOffer, currentFileOffer)
  const updateReady = useStore((s) => s.updateReady)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const elsewhere = useStore((s) => s.elsewhere)
  const eventName = useStore((s) => s.config.eventName)
  const switchEvent = useStore((s) => s.switchEvent)
  const setBoxesOpen = useStore((s) => s.setBoxesOpen)
  const elsewhereShown = elsewhere && {
    id: elsewhere.id,
    ...elsewhereView({ address: serverLabel(), open: eventName, here: elsewhere }),
  }
  const activeModuleId = useStore((s) => s.activeModuleId)
  const activeChannelId = useStore((s) => s.activeChannelId)
  const feedbackOpen = useStore((s) => s.feedbackOpen)
  const setFeedbackOpen = useStore((s) => s.setFeedbackOpen)

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

  // The app, having lost its box: nothing has answered at its address for a
  // while, or something else has. It looks for the box on the Wi-Fi until it
  // is back, and goes on with it wherever it proves itself (lib/follow.ts).
  const lost = isNative() && (elsewhere !== null || (!online && stuck))
  const search = useBoxSearch(lost)
  useFollowBoxes(search.services, lost ? 'open' : 'off')

  // Feedback or a crash report this device kept because the box was out of
  // reach: handed over each time the connection comes back. Background work,
  // never awaited, never an error.
  useEffect(() => {
    if (!online) return
    const token = sessionToken()
    if (token) void flushDeviceOutbox(token).catch(() => {})
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
  const screen = connectionScreen({ connection, hasConnected, hasCache, hasFailed })
  if (screen === 'unreachable') return <ServerUnreachable />
  if (screen === 'connecting') return <Connecting />

  return (
    <div className="app">
      {elsewhereShown ? (
        // Not "offline": nothing typed here is going to that box. It is the
        // way to it, and everything here stays on this device as it is. A
        // box that has not shown it is the event's is not a way anywhere:
        // Your boxes is, where its address can be typed.
        <button
          className="conn-banner conn-offline conn-banner-stuck"
          onClick={() =>
            elsewhereShown.opens ? switchEvent(elsewhereShown.id) : setBoxesOpen(true)
          }
        >
          {elsewhereShown.copy}{' '}
          <span className="conn-banner-why">{elsewhereShown.opens ? 'Open it' : 'Your boxes'}</span>
        </button>
      ) : (
        connection !== 'online' &&
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
        ))
      )}
      {helpOpen && <ConnectionHelp onClose={() => setHelpOpen(false)} />}
      {(toasts.length > 0 || fileOffer) && (
        <div className="toast-stack">
          {toasts.map((toast) => (
            <div key={toast.id} className={`flash flash-${toast.kind}`}>
              {toast.message}
            </div>
          ))}
          {fileOffer && <FileOfferBar key={fileOffer.id} offer={fileOffer} />}
        </div>
      )}
      <AlertBanner />
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
          {/* A module or channel that throws takes only this pane down: the
              sidebar, the voice bar and every other module keep working, and
              moving anywhere else clears it. */}
          <ErrorBoundary
            header={<DrawerButton />}
            resetKey={`${activeModuleId ?? ''}:${activeChannelId ?? ''}`}
            version={APP_VERSION}
            send={(crash) => sendCrash(crash, sessionToken() ?? '')}
          >
            <Main />
          </ErrorBoundary>
        </main>
      </div>
      {searchOpen && <SearchOverlay />}
      {/* The cog is visible to everyone; the password is what gates the
          panel, so the gate lives here rather than around the button. */}
      {adminOpen && (adminToken ? <AdminPanel /> : <AdminUnlock />)}
      {audioSettingsOpen && <AudioSettings />}
      {fileDetail && <FileDetail />}
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      <IosInstallTip />
    </div>
  )
}

// The macOS menu-bar wrapper around the box.
//
// Why this exists: the box is a Node single-file executable, which is a plain
// console program. Double-clicked from a .app it has no terminal to print to,
// and — never having linked AppKit — it never checks in with the window
// server, so macOS drops its Dock icon a moment after launch. The result was a
// box running invisibly with no way to stop it short of Activity Monitor.
//
// So the bundle's main executable is this instead. It owns the menu-bar item
// and runs the real box as a child process. `LSUIElement` is true: a server
// belongs beside the clock, not in the Dock.
//
// It deliberately knows almost nothing about crewbox. Everything it displays
// comes from box-status.json, which the box writes after it starts listening
// (see server/src/box.ts). That keeps this file out of the release cycle for
// anything but its own behaviour, and — more importantly — lets the menu still
// work when the server is wedged: "not running" and Quit have to be reachable
// precisely when the thing is broken.
import AppKit
import Foundation

// MARK: - Status file

/// A newer release the box heard about. Absent most of the time.
struct UpdateInfo: Decodable {
    let version: String
    let url: String
}

struct BoxStatus: Decodable {
    let pid: Int32
    let port: Int
    let secure: Bool
    let joinUrl: String
    let urls: [String]
    let eventPin: String
    let eventName: String
    let version: String
    // Optional so a status file written by a box that predates this field
    // still decodes — which is what lets a helper and a box be different
    // versions, the normal state immediately after an update.
    let update: UpdateInfo?
}

/// The box's admin link: the panel, unlocked, once (server/src/adminLink.ts).
///
/// A file of its own rather than a field in box-status.json, because the key
/// in it is as good as the password and the box writes it readable by this
/// user only. Absent from a box that predates it, and then the menu opens the
/// password prompt instead, which is what it always did.
struct AdminLink: Decodable {
    let pid: Int32
    let url: String
}

/// Where the box keeps its data — the same rule the box itself applies.
///
/// `DATA_DIR` when it is set, because this wrapper *passes that variable
/// through* to the box it launches and then looked somewhere else for the
/// status file. A Mac started with `DATA_DIR=/Volumes/Show/crewbox` got a
/// menu bar reporting on `~/.crewbox/data`: no box running, nothing to quit,
/// while one was serving the whole crew.
func dataDir() -> URL {
    if let dir = ProcessInfo.processInfo.environment["DATA_DIR"], !dir.isEmpty {
        return URL(fileURLWithPath: dir)
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".crewbox")
        .appendingPathComponent("data")
}

/// The box's published status, or nil when it isn't running.
///
/// A hard power cut leaves the file behind, so the pid is checked rather than
/// trusted: `kill(pid, 0)` succeeds only while that process still exists.
/// Reporting a dead box as running would be the one thing worse than no menu
/// at all, because the whole point of this is to tell you the truth about it.
func readStatus() -> BoxStatus? {
    let path = dataDir().appendingPathComponent("box-status.json")
    guard let data = try? Data(contentsOf: path),
          let status = try? JSONDecoder().decode(BoxStatus.self, from: data)
    else { return nil }
    guard kill(status.pid, 0) == 0 || errno == EPERM else { return nil }
    return status
}

/// The admin link for the box that is running now, or nil.
///
/// Read at the moment it is clicked, never kept: the key works once, and the
/// box writes a new one as soon as it is used. A link from any other process
/// is a key nobody can spend, so the pid has to be the running box's.
func readAdminLink(for status: BoxStatus) -> String? {
    let path = dataDir().appendingPathComponent("admin-link.json")
    guard let data = try? Data(contentsOf: path),
          let link = try? JSONDecoder().decode(AdminLink.self, from: data),
          link.pid == status.pid
    else { return nil }
    return link.url
}

// MARK: - App

final class CrewboxMenuBar: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var box: Process?
    private var refreshTimer: Timer?
    /// Set while we are deliberately stopping the box, so the termination
    /// handler doesn't report a crash for a shutdown we asked for.
    private var stopping = false
    /// When the running box was launched, to tell a box that crashed from one
    /// that never managed to start.
    private var startedAt = Date()
    /// When this wrapper last restarted a box on its own, newest last.
    private var restarts: [Date] = []

    /// A box that dies after running this long is restarted without asking.
    ///
    /// One that dies sooner never got going — a port somebody else holds, a
    /// second copy of the app, a data folder it cannot write — and starting it
    /// again would only fail the same way, so that still gets the alert.
    private static let restartAfterUptime: TimeInterval = 30
    /// At most this many automatic restarts inside `restartWindow`. A box that
    /// keeps dying needs a person, not a loop.
    private static let maxRestarts = 5
    private static let restartWindow: TimeInterval = 10 * 60

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            // A template image so it inverts correctly in dark mode and when
            // the menu bar is highlighted — a coloured icon looks wrong in one
            // of the two, and crew use this indoors and out.
            let image = NSImage(
                systemSymbolName: "antenna.radiowaves.left.and.right",
                accessibilityDescription: "Crewbox"
            )
            image?.isTemplate = true
            button.image = image
        }
        rebuildMenu()
        startBox()

        // Cheap poll: the status file appears a second or two after launch and
        // vanishes on shutdown, and the event name and PIN change when someone
        // finishes setup. Two seconds is well under the time it takes anyone
        // to walk back to the machine.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
    }

    // MARK: Running the box

    private func boxExecutable() -> URL? {
        Bundle.main.url(forResource: "crewbox-server", withExtension: nil)
    }

    private func startBox() {
        guard let exe = boxExecutable() else {
            alert(
                "Crewbox is incomplete",
                "The server executable is missing from the app bundle. "
                    + "Download the Crewbox .dmg again."
            )
            NSApp.terminate(nil)
            return
        }
        let process = Process()
        process.executableURL = exe
        // The box opens the browser itself on first run; that behaviour is
        // wanted here too, so nothing is suppressed.
        process.environment = ProcessInfo.processInfo.environment
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                self.box = nil
                self.rebuildMenu()
                // A box that dies on its own is worth interrupting someone
                // for: with no terminal and no Dock icon, silence here is
                // exactly the failure this whole file exists to end.
                if proc.terminationStatus != 0 {
                    // Unless it can simply be started again. A box that was
                    // serving and then died — out of memory, a crash in native
                    // code, anything the box's own safety net cannot catch —
                    // is restarted after two seconds, the way systemd restarts
                    // a Linux box. Crew phones reconnect by themselves and the
                    // outbox resends; the box itself notices the unclean exit
                    // on its way up and offers the crash report in the admin
                    // panel. Only when that keeps happening does it stop and
                    // say so.
                    let now = Date()
                    self.restarts = self.restarts.filter {
                        now.timeIntervalSince($0) < Self.restartWindow
                    }
                    if now.timeIntervalSince(self.startedAt) >= Self.restartAfterUptime
                        && self.restarts.count < Self.maxRestarts
                    {
                        self.restarts.append(now)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                            guard let self, self.box == nil, !self.stopping else { return }
                            self.startBox()
                        }
                        return
                    }
                    self.alert(
                        "Crewbox stopped",
                        "The box exited unexpectedly (status \(proc.terminationStatus)). "
                            + "Choose Start Crewbox to try again."
                    )
                }
            }
        }
        do {
            startedAt = Date()
            try process.run()
            box = process
        } catch {
            alert("Crewbox could not start", error.localizedDescription)
        }
        rebuildMenu()
    }

    /// SIGTERM, then wait, then SIGKILL. The box closes its database on
    /// SIGTERM (server/src/index.ts) and SQLite in WAL mode survives being
    /// killed anyway, so the deadline is about not hanging Quit rather than
    /// about safety.
    private func stopBox() {
        guard let process = box, process.isRunning else {
            // Not ours to stop — but still stoppable.
            //
            // The menu reports on whatever box owns this data directory, not
            // only the one this wrapper launched. Somebody who started the
            // box from a terminal, or left an older wrapper's box running,
            // got a menu saying "running" and a Quit that silently did
            // nothing. The status file names the pid; the Windows tray has
            // always done this.
            if let pid = readStatus()?.pid {
                stopping = true
                kill(pid, SIGTERM)
                let deadline = Date().addingTimeInterval(5)
                while readStatus() != nil && Date() < deadline {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                }
                stopping = false
            }
            return
        }
        stopping = true
        process.terminate()
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        box = nil
        stopping = false
    }

    // MARK: Menu

    private func rebuildMenu() {
        let menu = NSMenu()
        let status = readStatus()

        if let status {
            let title = status.eventName.isEmpty ? "Crewbox" : status.eventName
            menu.addItem(header("\(title) — running"))
            if !status.version.isEmpty {
                menu.addItem(header("Version \(status.version)"))
            }

            // The box does the asking; this only draws what it was told.
            //
            // Opens the admin panel, not the release page. Downloading a file
            // from a browser was the only answer before the box could update
            // itself; now it is the wrong one, and it would leave somebody
            // holding a binary with no idea what to do with it. Nothing is
            // installed by this click either — the panel asks twice, and shows
            // what a restart would interrupt before it does anything.
            //
            // Unlocked, like "Open the admin panel" below: the update is the
            // panel's to do, and a password prompt is where it used to stop.
            if let update = status.update, !update.version.isEmpty {
                let item = action(
                    "Update available: \(update.version)", #selector(openAdmin),
                    represented: status.joinUrl + "?admin")
                item.attributedTitle = NSAttributedString(
                    string: "Update available: \(update.version)",
                    attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)])
                menu.addItem(item)
            }

            menu.addItem(.separator())

            menu.addItem(
                action("Open the join page", #selector(openJoin), represented: status.joinUrl))
            menu.addItem(
                action(
                    "Open the QR poster page", #selector(openConnect),
                    represented: "\(status.joinUrl)/connect"))
            // The way into the admin panel for whoever is at the box, without
            // the password. The box printed that once, to a console a .app
            // does not have, so this is how somebody who never saw it gets in
            // and sets one they will remember. The represented URL is only
            // the fallback, for a box too old to write an admin link.
            menu.addItem(
                action(
                    "Open the admin panel", #selector(openAdmin),
                    represented: status.joinUrl + "?admin"))
            menu.addItem(
                action("Copy the join link", #selector(copyJoin), represented: status.joinUrl))
            menu.addItem(
                action(
                    "Copy the event PIN  (\(status.eventPin))", #selector(copyPin),
                    represented: status.eventPin))

            if status.urls.count > 1 {
                // More than one network means more than one address the crew
                // might have to type. Which one works is a property of the
                // Wi-Fi they are on, not something the box can decide.
                let others = NSMenu()
                for url in status.urls {
                    others.addItem(action(url, #selector(copyJoin), represented: url))
                }
                let item = NSMenuItem(title: "Other addresses", action: nil, keyEquivalent: "")
                item.submenu = others
                menu.addItem(item)
            }
        } else if box?.isRunning == true {
            menu.addItem(header("Crewbox — starting…"))
        } else {
            menu.addItem(header("Crewbox — not running"))
            menu.addItem(.separator())
            menu.addItem(action("Start Crewbox", #selector(restart)))
        }

        menu.addItem(.separator())
        menu.addItem(action("Open the data folder", #selector(openDataDir)))
        menu.addItem(.separator())
        // Named for what it does. "Quit" alone reads as closing a window, and
        // the thing someone wants to be sure of here is that the box stopped.
        menu.addItem(action("Stop Crewbox and quit", #selector(quit), key: "q"))

        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
    }

    private func header(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(
        _ title: String, _ selector: Selector, key: String = "", represented: String? = nil
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.representedObject = represented
        return item
    }

    // MARK: Actions

    @objc private func openJoin(_ sender: NSMenuItem) { open(sender.representedObject as? String) }
    /// The admin link if the box has one for us, the password prompt if not.
    @objc private func openAdmin(_ sender: NSMenuItem) {
        let link = readStatus().flatMap { readAdminLink(for: $0) }
        open(link ?? (sender.representedObject as? String))
    }
    @objc private func openConnect(_ sender: NSMenuItem) {
        open(sender.representedObject as? String)
    }

    @objc private func copyJoin(_ sender: NSMenuItem) { copy(sender.representedObject as? String) }
    @objc private func copyPin(_ sender: NSMenuItem) { copy(sender.representedObject as? String) }

    @objc private func openDataDir() { NSWorkspace.shared.open(dataDir()) }

    @objc private func restart() { startBox() }

    @objc private func quit() {
        stopBox()
        NSApp.terminate(nil)
    }

    private func open(_ string: String?) {
        guard let string, let url = URL(string: string) else { return }
        NSWorkspace.shared.open(url)
    }

    private func copy(_ string: String?) {
        guard let string else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }

    private func alert(_ title: String, _ body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = .warning
        // Without this the alert can open behind whatever is in front, which
        // for a menu-bar app with no windows means it is never seen.
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // Quitting via ⌘Q, the Apple menu, or a logout must all stop the child
    // too — otherwise this "fix" leaves exactly the orphaned, unkillable box
    // it was written to prevent.
    func applicationWillTerminate(_ notification: Notification) {
        stopBox()
    }
}

let app = NSApplication.shared
let delegate = CrewboxMenuBar()
app.delegate = delegate
// .accessory, matching LSUIElement: menu bar only, no Dock icon, no menu bar
// title of its own.
app.setActivationPolicy(.accessory)
app.run()

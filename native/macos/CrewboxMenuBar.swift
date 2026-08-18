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

func dataDir() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
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

// MARK: - App

final class CrewboxMenuBar: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var box: Process?
    private var refreshTimer: Timer?
    /// Set while we are deliberately stopping the box, so the termination
    /// handler doesn't report a crash for a shutdown we asked for.
    private var stopping = false

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
                    self.alert(
                        "Crewbox stopped",
                        "The box exited unexpectedly (status \(proc.terminationStatus)). "
                            + "Choose Start Crewbox to try again."
                    )
                }
            }
        }
        do {
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
        guard let process = box, process.isRunning else { return }
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
            if let update = status.update, !update.version.isEmpty {
                let item = action(
                    "Update available: \(update.version)", #selector(openUpdate),
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
    @objc private func openUpdate(_ sender: NSMenuItem) {
        open(sender.representedObject as? String)
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

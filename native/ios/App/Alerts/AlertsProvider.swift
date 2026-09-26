import Foundation
import NetworkExtension

/// crewbox's Local Push provider (docs/ALERTS.md).
///
/// iOS starts it when the phone joins a Wi-Fi the app registered and stops it
/// when the phone leaves, whether crewbox is open, in the background or the
/// phone is locked. It does one thing: it keeps a `/ws/alerts` connection to
/// each box the app listed for that Wi-Fi, and posts what the boxes send.
/// The box decides what buzzes; nothing here parses a message.
///
/// Apple asks for a small memory footprint (24 MiB measured by Apple staff),
/// and cleanup in `stop`, never in `deinit`: the process simply ends.
final class AlertsProvider: NEAppPushProvider {
    private var links: [String: BoxLink] = [:]
    private var watching: NSKeyValueObservation?
    private let queue = DispatchQueue(label: "com.colmhewson.crewbox.alerts")

    override func start() {
        // The app changes the list when the phone signs in or out of an
        // event on this Wi-Fi; iOS updates the configuration in place.
        watching = observe(\.providerConfiguration, options: [.new]) { [weak self] _, _ in
            self?.queue.async { self?.connectAll() }
        }
        queue.async { self.connectAll() }
    }

    override func stop(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        watching = nil
        queue.async {
            self.links.values.forEach { $0.close() }
            self.links = [:]
            completionHandler()
        }
    }

    /// Every 60 seconds, which can't be changed. Apple's pattern: the box
    /// sends heartbeats, this answers them, and the timer reconnects a link
    /// that has heard nothing for three. Ordinary timers run late while the
    /// phone sleeps; this doesn't.
    override func handleTimerEvent() {
        queue.async {
            self.links.values.forEach { $0.checkAlive() }
            self.connectAll()
        }
    }

    /// One link per box listed, each opened unless it is open or has been
    /// refused; links to boxes no longer listed closed.
    private func connectAll() {
        let boxes = AlertsBox.list(in: providerConfiguration)
        let wanted = Dictionary(boxes.map { ($0.origin, $0) }, uniquingKeysWith: { _, last in last })
        for (origin, link) in links where wanted[origin] != link.box {
            link.close()
            links[origin] = nil
        }
        for (origin, box) in wanted {
            let link = links[origin] ?? BoxLink(box: box, queue: queue, post: AlertPoster.shared)
            links[origin] = link
            link.connectIfIdle()
        }
    }
}

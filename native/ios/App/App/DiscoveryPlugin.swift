import Capacitor
import Foundation
import Network
import UIKit

/// Crew boxes on the Wi-Fi, for the page (web/src/lib/discovery.ts), as
/// `window.Capacitor.Plugins.CrewboxDiscovery`.
///
/// A box announces `_crewbox._tcp` on its crew network (docs/DISCOVERY.md).
/// NWBrowser finds the services and their TXT records. Network framework has
/// no way to turn a service into an address (Apple DTS on the developer
/// forums, thread 673771), so NetService looks each one up, on the main run
/// loop it needs. Everything here runs on the main queue.
///
/// Looking is what iOS asks about. The first search shows the Local Network
/// alert, which is why the page waits for a tap before its first one, and why
/// Info.plist lists the type in NSBonjourServices: without it the browser
/// fails with NoAuth. A search somebody has said no to waits with
/// PolicyDenied, passed on as `denied`, and `openSettings` is the way back.
///
/// What is passed on is what the network said and no more. The page treats
/// every entry as a claim and asks the box itself before using one.
@objc(DiscoveryPlugin)
public class DiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DiscoveryPlugin"
    public let jsName = "CrewboxDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    /// The one type this app looks for, as NSBonjourServices lists it.
    private static let serviceType = "_crewbox._tcp"

    /// The TXT keys the page reads (docs/DISCOVERY.md). Nothing else is passed on.
    private static let txtKeys = ["txtvers", "id", "name", "ver", "proto", "setup", "tls"]

    /// kDNSServiceErr_PolicyDenied in dns_sd.h: Local Network is off for this app.
    private static let policyDenied: Int32 = -65570

    private struct Service {
        let name: String
        let type: String
        let domain: String
        var txt: [String: String]
        var addresses: [String] = []
        var port = 0
    }

    private var browser: NWBrowser?
    /// What the browser reports now, by service name.
    private var services: [String: Service] = [:]
    private var lookups: [String: Lookup] = [:]
    /// The page has asked for a search and not stopped it.
    private var wanted = false
    /// The last state passed on, so a page that asks again hears it again.
    private var state = ""
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        observers = [
            // Out of sight is out of the search. A browser started in the
            // background while Local Network is undecided is refused without
            // asking, and iOS does not remember that it refused (TN3179).
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.end()
            },
            // Back again, or back from the alert or from Settings. A browser
            // left waiting on a denial is started afresh: whether it would
            // notice Local Network being switched on by itself is not
            // something Apple documents.
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self, self.wanted else { return }
                if self.browser == nil || self.state == "denied" || self.state == "waiting" {
                    self.begin()
                }
            },
        ]
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.wanted = true
            if self.browser == nil {
                self.begin()
            } else {
                // Already looking, for a page that has just loaded: tell it
                // what there is so far.
                if !self.state.isEmpty { self.emitState(self.state) }
                self.emitBoxes()
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.wanted = false
            self.end()
            call.resolve()
        }
    }

    /// The app's own page in Settings, where Local Network is switched on.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("This iPhone has no Settings page for the app")
                return
            }
            UIApplication.shared.open(url) { _ in call.resolve() }
        }
    }

    private func begin() {
        end()
        guard UIApplication.shared.applicationState != .background else { return }
        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil),
            using: NWParameters()
        )
        browser.stateUpdateHandler = { [weak self, weak browser] state in
            guard let self, let browser, self.browser === browser else { return }
            self.changed(state)
        }
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
            guard let self, let browser, self.browser === browser else { return }
            self.found(results)
        }
        self.browser = browser
        browser.start(queue: .main)
    }

    private func end() {
        browser?.cancel()
        browser = nil
        for lookup in lookups.values {
            lookup.cancel()
        }
        lookups = [:]
        services = [:]
        state = ""
    }

    private func changed(_ state: NWBrowser.State) {
        switch state {
        case .ready:
            // Registered, which is not the same as allowed: a first search
            // sits here while the alert is up, and finds nothing until it is
            // answered.
            emitState("searching")
        case .waiting(let error):
            if case .dns(let code) = error, code == Self.policyDenied {
                emitState("denied")
            } else {
                emitState("waiting", reason: "\(error)")
            }
        case .failed(let error):
            // NoAuth (-65555) is a build without NSBonjourServices, not
            // anything the user did. The page's next start tries again.
            emitState("failed", reason: "\(error)")
            browser?.cancel()
            browser = nil
        default:
            break
        }
    }

    private func found(_ results: Set<NWBrowser.Result>) {
        var now: [String: Service] = [:]
        for result in results {
            guard case let .service(name, type, domain, _) = result.endpoint else { continue }
            var txt: [String: String] = [:]
            if case let .bonjour(record) = result.metadata {
                txt = Self.entries(of: record)
            }
            // One box on two interfaces is two results with one name.
            if let seen = now[name], !seen.txt.isEmpty, txt.isEmpty { continue }
            now[name] = Service(name: name, type: type, domain: domain, txt: txt)
        }
        for name in services.keys where now[name] == nil {
            services[name] = nil
            lookups.removeValue(forKey: name)?.cancel()
        }
        for (name, service) in now {
            if let known = services[name] {
                if known.txt == service.txt { continue }
                // Its record changed: keep showing it where it was while it
                // is looked up again, in case it has moved as well.
                var updated = service
                updated.addresses = known.addresses
                updated.port = known.port
                services[name] = updated
            } else {
                services[name] = service
            }
            lookUp(service)
        }
        emitBoxes()
    }

    private func lookUp(_ service: Service) {
        lookups[service.name]?.cancel()
        let name = service.name
        let lookup = Lookup(name: name, type: service.type, domain: service.domain) {
            [weak self] addresses, port in
            guard let self, var entry = self.services[name] else { return }
            self.lookups[name] = nil
            entry.addresses = addresses
            entry.port = port
            self.services[name] = entry
            self.emitBoxes()
        }
        lookups[name] = lookup
        lookup.start()
    }

    private func emitBoxes() {
        // The page that asked has gone: reloaded, or moved on without saying.
        // The bridge drops its listeners when it does, so this is the sign.
        guard hasListeners("boxes") else {
            wanted = false
            end()
            return
        }
        let boxes: [[String: Any]] = services.values
            .filter { $0.port > 0 && !$0.addresses.isEmpty }
            .sorted { $0.name < $1.name }
            .map { box -> [String: Any] in
                ["name": box.name, "addresses": box.addresses, "port": box.port, "txt": box.txt]
            }
        notifyListeners("boxes", data: ["boxes": boxes])
    }

    private func emitState(_ state: String, reason: String? = nil) {
        self.state = state
        var data: [String: Any] = ["state": state]
        if let reason { data["reason"] = reason }
        notifyListeners("state", data: data)
    }

    /// The keys the page reads, as strings: '' for a key with no value.
    /// Read one key at a time, never as NetService's dictionary, which holds
    /// NSNull for a key with no value and so for the box's bare `tls`.
    private static func entries(of record: NWTXTRecord) -> [String: String] {
        var txt: [String: String] = [:]
        for key in txtKeys {
            switch record.getEntry(for: key) {
            case .string(let value):
                txt[key] = value
            case .empty:
                txt[key] = ""
            case .data(let data):
                if let value = String(data: data, encoding: .utf8) { txt[key] = value }
            default:
                break
            }
        }
        return txt
    }
}

/// Where one found service is, by NetService's resolve, which reports each
/// address as it learns it. A box publishes only its IPv4 address
/// (server/src/announce/responder.ts), so the first IPv4 address ends the
/// lookup. One that times out is tried once more, two seconds later.
private final class Lookup: NSObject, NetServiceDelegate {
    private let service: NetService
    private let done: ([String], Int) -> Void
    private var tries = 0
    private var finished = false

    init(name: String, type: String, domain: String, done: @escaping ([String], Int) -> Void) {
        service = NetService(domain: domain, type: type, name: name)
        self.done = done
        super.init()
        service.delegate = self
    }

    func start() {
        tries += 1
        service.resolve(withTimeout: 5)
    }

    func cancel() {
        finished = true
        service.delegate = nil
        service.stop()
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard !finished else { return }
        let ipv4 = (sender.addresses ?? []).compactMap(Lookup.ipv4)
        guard !ipv4.isEmpty, sender.port > 0 else { return }
        finished = true
        sender.stop()
        done(ipv4, sender.port)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        guard !finished, tries < 2 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, !self.finished else { return }
            self.start()
        }
    }

    /// The IPv4 address in a sockaddr, read as bytes: a Darwin sockaddr_in is
    /// its length, its family, the port, then the four bytes of the address.
    static func ipv4(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        guard bytes.count >= 8, bytes[1] == UInt8(AF_INET) else { return nil }
        return bytes[4..<8].map { String($0) }.joined(separator: ".")
    }
}

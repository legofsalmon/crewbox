import Foundation
import Network
import Security

/// One box's `/ws/alerts` connection, from the provider (docs/ALERTS.md).
///
/// It opens with a fresh challenge, checks the box's signed first frame
/// against the key the phone kept for the event before it sends the
/// sign-in, then posts what the box sends. Everything runs on the
/// provider's one queue.
final class BoxLink {
    let box: AlertsBox
    private let queue: DispatchQueue
    private let post: AlertPoster
    private var connection: NWConnection?
    private var nonce = ""
    private var host = ""
    private var proven = false
    /// The box said no for good: another event, a signature that isn't the
    /// kept key's, or a dead sign-in (4001). Not retried until the app lists
    /// the box again.
    private var refused = false
    private var beatMs: Double = 30_000
    private var lastHeard = Date.distantPast

    init(box: AlertsBox, queue: DispatchQueue, post: AlertPoster) {
        self.box = box
        self.queue = queue
        self.post = post
    }

    func connectIfIdle() {
        guard connection == nil, !refused, let url = socketURL() else { return }
        nonce = BoxProof.nonce()
        guard let withNonce = URL(string: url.absoluteString + "?nonce=" + nonce) else { return }
        host = BoxProof.host(of: withNonce)
        proven = false
        lastHeard = Date()

        let parameters: NWParameters = withNonce.scheme == "wss" ? .tls : .tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        let connection = NWConnection(to: .url(withNonce), using: parameters)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection, self.connection === connection else { return }
            switch state {
            case .failed, .cancelled:
                self.connection = nil
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(on: connection)
    }

    func close() {
        connection?.cancel()
        connection = nil
    }

    /// Called by the provider's timer: a link that has heard nothing for three
    /// beats is closed, and opened again.
    func checkAlive() {
        guard connection != nil else { return }
        if Date().timeIntervalSince(lastHeard) * 1000 > 3 * beatMs {
            close()
            connectIfIdle()
        }
    }

    // MARK: The socket

    /// `ws://host/ws/alerts` for `http://host`, `wss://` for `https://`.
    private func socketURL() -> URL? {
        guard var parts = URLComponents(string: box.origin) else { return nil }
        switch parts.scheme?.lowercased() {
        case "https": parts.scheme = "wss"
        case "http": parts.scheme = "ws"
        default: return nil
        }
        parts.path = "/ws/alerts"
        parts.query = nil
        return parts.url
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, self.connection === connection else { return }
            if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata, metadata.opcode == .close {
                if case .privateCode(4001) = metadata.closeCode {
                    // The sign-in is dead: nothing to send until the app
                    // signs in again and lists the box afresh.
                    self.refused = true
                }
                self.close()
                return
            }
            if let data, !data.isEmpty { self.handle(data) }
            if error != nil {
                self.close()
                return
            }
            if self.connection === connection { self.receive(on: connection) }
        }
    }

    private func send(_ frame: [String: Any]) {
        guard let connection, let data = try? JSONSerialization.data(withJSONObject: frame) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
    }

    // MARK: Frames

    private func handle(_ data: Data) {
        guard let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = frame["type"] as? String
        else { return }
        lastHeard = Date()
        if let t = frame["t"] as? NSNumber, proven { Since.heard(t.doubleValue, from: box.origin) }

        if type == "box" {
            let verdict = BoxProof.check(
                keptEventId: box.eventId, keptKey: box.eventKey, host: host, nonce: nonce,
                frameEventId: frame["eventId"] as? String, signature: frame["signature"] as? String)
            guard verdict == .proven || verdict == .sameEvent, let token = SignIn.token(named: box.session)
            else {
                // Anything else answering at this address on a Wi-Fi of the
                // same name never sees the sign-in.
                refused = verdict == .anotherEvent || verdict == .refused
                close()
                return
            }
            if let beat = frame["beatMs"] as? NSNumber, beat.doubleValue > 0 { beatMs = beat.doubleValue }
            proven = true
            var hello: [String: Any] = [
                "type": "hello", "token": token, "timeZone": TimeZone.current.identifier,
            ]
            if let since = Since.last(from: box.origin) {
                hello["since"] = NSNumber(value: since)
            } else {
                hello["since"] = NSNull()
            }
            send(hello)
            return
        }
        guard proven else { return }
        switch type {
        case "welcome":
            for alert in (frame["catchUp"] as? [[String: Any]]) ?? [] {
                post.post(alert, eventId: box.eventId)
            }
        case "alert":
            if let alert = frame["alert"] as? [String: Any] { post.post(alert, eventId: box.eventId) }
        case "read":
            if let channel = frame["channelId"] as? String, let seq = frame["seq"] as? NSNumber {
                post.read(channel: channel, upTo: seq.intValue, eventId: box.eventId)
            }
        case "withdraw":
            post.withdraw((frame["ids"] as? [String]) ?? [])
        case "beat":
            send(["type": "beat", "t": frame["t"] ?? NSNull()])
        default:
            // settings and stages are the app's business; a frame this build
            // doesn't know is skipped, never an error.
            break
        }
    }
}

/// When the provider last heard from each box, in the box's clock, kept in
/// the App Group for the next hello's `since`.
enum Since {
    private static var defaults: UserDefaults? { UserDefaults(suiteName: AlertsShared.appGroup) }

    static func last(from origin: String) -> Double? {
        (defaults?.dictionary(forKey: AlertsShared.sinceKey)?[origin] as? NSNumber)?.doubleValue
    }

    static func heard(_ t: Double, from origin: String) {
        guard let defaults else { return }
        var all = defaults.dictionary(forKey: AlertsShared.sinceKey) ?? [:]
        if let known = (all[origin] as? NSNumber)?.doubleValue, known >= t { return }
        all[origin] = t
        defaults.set(all, forKey: AlertsShared.sinceKey)
    }
}

/// The sign-in the app keeps for an event, from the App Group's Keychain
/// group (SessionsPlugin.swift). Readable after the phone's first unlock.
enum SignIn {
    static func token(named name: String) -> String? {
        var data: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: AlertsShared.sessionsService,
            kSecAttrAccount as String: name,
            kSecAttrAccessGroup as String: AlertsShared.appGroup,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ] as CFDictionary, &data)
        guard status == errSecSuccess, let bytes = data as? Data else { return nil }
        let token = String(decoding: bytes, as: UTF8.self)
        return token.isEmpty ? nil : token
    }
}

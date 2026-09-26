import CryptoKit
import Foundation

/// Whether the box answering `/ws/alerts` is the event's own, before the
/// provider sends it a sign-in (docs/ALERTS.md, "The box proves itself
/// first"). The same check as Android's BoxProof.java and the page's
/// lib/identity.ts.
///
/// It matters most here: iOS starts the provider on any Wi-Fi with a
/// registered name, and a name is all it matches on.
enum BoxProof {
    enum Verdict: Equatable {
        /// It signed for this event, this address and this challenge.
        case proven
        /// No key was kept for the event (it was joined before boxes had
        /// keys), and it says it runs the event.
        case sameEvent
        /// It says it runs another event.
        case anotherEvent
        /// A key was kept, and it didn't sign with it.
        case refused
    }

    static func statement(eventId: String, host: String, nonce: String) -> String {
        "crewbox-identity-v1\n\(eventId)\n\(host)\n\(nonce)"
    }

    /// The Host header a request to `url` carries, as the box signs it: lower
    /// case, with the port only when it isn't the scheme's own.
    static func host(of url: URL) -> String {
        guard var host = url.host?.lowercased() else { return "" }
        if host.contains(":"), !host.hasPrefix("[") { host = "[\(host)]" }
        let scheme = url.scheme?.lowercased() ?? ""
        let standard = scheme == "https" || scheme == "wss" ? 443 : 80
        guard let port = url.port, port != standard else { return host }
        return "\(host):\(port)"
    }

    static func check(
        keptEventId: String, keptKey: String, host: String, nonce: String,
        frameEventId: String?, signature: String?
    ) -> Verdict {
        guard let frameEventId, !frameEventId.isEmpty, frameEventId == keptEventId else {
            return .anotherEvent
        }
        if keptKey.isEmpty { return .sameEvent }
        guard let signature, !signature.isEmpty else { return .refused }
        let signed = statement(eventId: frameEventId, host: host, nonce: nonce)
        return verify(key: keptKey, statement: signed, signature: signature) ? .proven : .refused
    }

    /// Whether `signature` (P1363, base64url) is `key`'s (an uncompressed
    /// P-256 point, base64url) over `statement`. Never throws.
    static func verify(key: String, statement: String, signature: String) -> Bool {
        guard let point = base64url(key), point.count == 65, point.first == 0x04,
              let raw = base64url(signature), raw.count == 64,
              let publicKey = try? P256.Signing.PublicKey(x963Representation: point),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw)
        else { return false }
        return publicKey.isValidSignature(signature, for: Data(statement.utf8))
    }

    /// A fresh challenge: 32 random bytes, base64url.
    static func nonce() -> String {
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func base64url(_ text: String) -> Data? {
        var plain = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while plain.count % 4 != 0 { plain += "=" }
        return Data(base64Encoded: plain)
    }
}

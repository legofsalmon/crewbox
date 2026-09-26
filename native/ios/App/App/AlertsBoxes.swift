import Foundation

/// What the app tells its Local Push provider, and where the two meet.
/// Built into both the app and the Alerts extension.
enum AlertsShared {
    /// The provider extension's bundle id. It reaches phones and App Store
    /// Connect: never renamed.
    static let providerBundleId = "com.colmhewson.crewbox.alerts"
    /// The App Group the two share (SessionsPlugin.appGroup).
    static let appGroup = "group.com.colmhewson.crewbox"
    /// The Keychain service the sign-ins are under (SessionsPlugin.service).
    static let sessionsService = "com.colmhewson.crewbox.sessions"
    /// In the App Group's defaults: per box, when the provider last heard
    /// from it, in the box's clock, for the next hello's `since`. A storage
    /// name on phones.
    static let sinceKey = "crewbox.alerts.since"
}

/// One box the provider keeps a connection to while the phone is on its
/// Wi-Fi, as the app lists it in that Wi-Fi's manager (AlertsManagers).
///
/// None of it is secret: the sign-in stays in the Keychain, named here by
/// its storage name, because how iOS stores a manager's configuration isn't
/// documented.
struct AlertsBox: Equatable {
    /// The box's origin, as the page reaches it: `http://10.0.0.2:8080`.
    var origin: String
    var eventId: String
    /// The event's public key kept when the phone joined, base64url, or
    /// empty for an event joined before boxes had keys.
    var eventKey: String
    /// The sign-in's name in the Keychain (web/src/lib/sessions.ts).
    var session: String

    static let listKey = "boxes"

    init(origin: String, eventId: String, eventKey: String, session: String) {
        self.origin = origin
        self.eventId = eventId
        self.eventKey = eventKey
        self.session = session
    }

    init?(_ entry: Any) {
        guard let entry = entry as? [String: Any],
              let origin = entry["origin"] as? String, !origin.isEmpty,
              let eventId = entry["eventId"] as? String, !eventId.isEmpty,
              let session = entry["session"] as? String, !session.isEmpty
        else { return nil }
        self.init(
            origin: origin, eventId: eventId, eventKey: entry["eventKey"] as? String ?? "",
            session: session)
    }

    var entry: [String: Any] {
        ["origin": origin, "eventId": eventId, "eventKey": eventKey, "session": session]
    }

    static func list(in configuration: [String: Any]?) -> [AlertsBox] {
        ((configuration?[listKey] as? [Any]) ?? []).compactMap(AlertsBox.init)
    }

    static func configuration(_ boxes: [AlertsBox]) -> [String: Any] {
        [listKey: boxes.map(\.entry)]
    }
}

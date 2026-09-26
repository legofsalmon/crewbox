import Foundation
import UserNotifications

/// Posts the box's alerts as notifications, and takes them back
/// (docs/ALERTS.md, "An alert").
///
/// The alert's id is the notification's identifier, so one sent twice (a
/// catch-up overlapping what was posted, two providers during a quick Wi-Fi
/// drop) replaces rather than adds. A tap reaches the app's delegate
/// (AlertsNotifications.swift) with `link`, a `crewbox://open` link naming
/// the event and where to go, and `kind`, which decides whether it shows
/// while the app is open.
final class AlertPoster {
    static let shared = AlertPoster()
    private let center = UNUserNotificationCenter.current()

    func post(_ alert: [String: Any], eventId: String) {
        guard let id = alert["id"] as? String, !id.isEmpty,
              let content = AlertPoster.content(alert, eventId: eventId)
        else { return }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    /// The notification for an alert, or nil for one this build can't read.
    static func content(_ alert: [String: Any], eventId: String) -> UNMutableNotificationContent? {
        guard let kind = alert["kind"] as? String,
              let target = alert["target"] as? [String: Any],
              let link = link(eventId: eventId, target: target)
        else { return nil }
        let content = UNMutableNotificationContent()
        content.title = alert["title"] as? String ?? ""
        content.body = alert["body"] as? String ?? ""
        content.threadIdentifier = alert["thread"] as? String ?? ""
        // A catch-up's older alerts, and a busy thread, arrive without sound.
        content.sound = (alert["quiet"] as? Bool ?? false) ? nil : .default
        // Show stops and the first changeover calls come through a Focus that
        // allows Time Sensitive alerts; the capability is on both targets.
        content.interruptionLevel = (alert["urgent"] as? Bool ?? false) ? .timeSensitive : .active
        content.relevanceScore = kind == "showStop" ? 1 : kind == "changeover" ? 0.8 : 0.5
        var info: [String: Any] = ["kind": kind, "link": link, "event": eventId]
        if target["kind"] as? String == "channel", let channel = target["channelId"] as? String {
            info["channelId"] = channel
            if let seq = alert["seq"] as? NSNumber { info["seq"] = seq.intValue }
        }
        content.userInfo = info
        return content
    }

    /// Where a tap goes, as Android's AlertNotice builds it.
    static func link(eventId: String, target: [String: Any]) -> String? {
        var open = "crewbox://open?event=" + encode(eventId)
        switch target["kind"] as? String {
        case "channel":
            guard let channel = target["channelId"] as? String else { return nil }
            open += "&channel=" + encode(channel)
        case "showlog":
            open += "&to=showlog"
        case "stage":
            guard let stage = target["stage"] as? String else { return nil }
            open += "&stage=" + encode(stage)
        default:
            return nil
        }
        return open
    }

    private static func encode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    /// The person read a channel somewhere: take back its alerts up to `seq`.
    func read(channel: String, upTo seq: Int, eventId: String) {
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { notification in
                let info = notification.request.content.userInfo
                guard info["event"] as? String == eventId,
                      info["channelId"] as? String == channel,
                      let posted = info["seq"] as? Int
                else { return false }
                return posted <= seq
            }.map(\.request.identifier)
            if !ids.isEmpty { self.center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// Alerts that are no longer true: a deleted message, a moved set.
    func withdraw(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }
}

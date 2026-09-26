import ActivityKit
import Foundation

/// The stage countdown's Live Activity, from the app's side: which stage the
/// person put on the lock screen, and the one activity showing it.
///
/// Only the app's own process can start or update it without APNs, which a
/// box on a crew Wi-Fi can't use. So the page sends what to show whenever
/// its running order changes and whenever the app comes to the foreground,
/// and `staleDate` covers the time between: a little after the next set is
/// due on, the lock screen says to open crewbox instead.
///
/// A Live Activity lasts up to eight hours, shorter than a show day. Each
/// update from a foreground app to one more than an hour old ends it and
/// starts a fresh one, so a phone that is opened now and then keeps it all
/// day. Only a foreground app may start one (ActivityKit throws otherwise),
/// which is when the page sends.
enum LiveCountdown {
    /// The stage chosen, kept so the choice outlives an activity the system
    /// ended. A storage name on phones: never renamed.
    static let stageKey = "crewbox.countdown.stage"
    private static let startedKey = "crewbox.countdown.started"
    /// How long past the next set's start the lock screen still trusts it.
    static let staleAfter: TimeInterval = 5 * 60
    /// Past this age, an update starts a fresh activity.
    static let refreshAfter: TimeInterval = 60 * 60

    static var stage: String? {
        let stage = UserDefaults.standard.string(forKey: stageKey) ?? ""
        return stage.isEmpty ? nil : stage
    }

    /// Choose `stage`, or none, and show `content` for it when given. Returns
    /// the stage on the lock screen afterwards: nil when there is none, or
    /// when Live Activities are off for crewbox.
    static func set(stage: String?, content: CountdownAttributes.ContentState?) async -> String? {
        guard let stage, !stage.isEmpty else {
            UserDefaults.standard.removeObject(forKey: stageKey)
            await endAll()
            return nil
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            UserDefaults.standard.removeObject(forKey: stageKey)
            await endAll()
            return nil
        }
        UserDefaults.standard.set(stage, forKey: stageKey)
        // Without content the page is only naming the stage; what it shows
        // follows at once (web/src/components/LockScreenCountdown.tsx).
        guard let content else { return stage }
        // Nothing on and nothing next: the stage's show day is over. The
        // choice stays, for tomorrow.
        guard content.onNow != nil || content.next != nil else {
            await endAll()
            return stage
        }
        let stale = staleDate(for: content)
        let current = Activity<CountdownAttributes>.activities.first {
            $0.attributes.stage == stage && $0.activityState == .active
        }
        let started = UserDefaults.standard.double(forKey: startedKey)
        if let current, Date().timeIntervalSince1970 - started < refreshAfter {
            await current.update(ActivityContent(state: content, staleDate: stale))
            return stage
        }
        await endAll()
        do {
            _ = try Activity.request(
                attributes: CountdownAttributes(stage: stage),
                content: ActivityContent(state: content, staleDate: stale),
                pushType: nil
            )
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: startedKey)
            return stage
        } catch {
            // Not in the foreground, or too many activities: the choice stays,
            // and the next foreground update tries again.
            return stage
        }
    }

    /// A little after the next set is due on, or after the set on now is due
    /// off when nothing follows: past it the running order may have moved
    /// without this phone hearing.
    static func staleDate(for content: CountdownAttributes.ContentState) -> Date? {
        let point = content.next?.start ?? content.onNow?.end
        return point.map { $0.addingTimeInterval(staleAfter) }
    }

    private static func endAll() async {
        for activity in Activity<CountdownAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}

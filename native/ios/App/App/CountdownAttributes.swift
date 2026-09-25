import ActivityKit
import Foundation

/// The stage countdown on the lock screen, as a Live Activity (docs/ALERTS.md,
/// "The countdown"). Built into both the app, which starts and updates it,
/// and the Countdown widget extension, which draws it; ActivityKit matches
/// the two by this type.
///
/// The app never has the box's `stages` frame, which the Local Push provider
/// hears, so the page works out what is on and next from its own running
/// order, in this phone's zone, with the box's maths (shared/src/alerts.ts,
/// `countdownFor`), and hands it over. The instants are counted to with this
/// phone's clock.
struct CountdownAttributes: ActivityAttributes {
    struct Slot: Codable, Hashable {
        var name: String
        var start: Date
        /// Nil when the running order gives no end and nothing follows.
        var end: Date?
    }

    struct ContentState: Codable, Hashable {
        var onNow: Slot?
        var next: Slot?

        /// What the timer counts to: the end of the set on now while there is
        /// one, else the next set's start. Past it, the timer counts up, so a
        /// set that runs over shows by how much, with no network.
        var target: Date? { onNow?.end ?? next?.start }
    }

    /// The stage's name, as the running order has it. Fixed for the life of
    /// one activity; another stage is another activity.
    var stage: String
}

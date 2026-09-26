import ActivityKit
import SwiftUI
import WidgetKit

/// The Countdown extension: nothing but the stage countdown's Live Activity.
/// No home-screen widget, so there is nothing to add from the widget gallery.
@main
struct CountdownWidgets: WidgetBundle {
    var body: some Widget {
        CountdownLiveActivity()
    }
}

struct CountdownLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CountdownAttributes.self) { context in
            CountdownLockScreen(stage: context.attributes.stage, state: context.state, stale: context.isStale)
                .padding()
                .activityBackgroundTint(nil)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.stage)
                        .font(.caption)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    CountdownTimer(state: context.state)
                        .font(.caption.monospacedDigit())
                }
                DynamicIslandExpandedRegion(.bottom) {
                    CountdownLines(state: context.state, stale: context.isStale)
                        .font(.caption)
                }
            } compactLeading: {
                Text(initials(context.attributes.stage))
                    .font(.caption2.bold())
            } compactTrailing: {
                CountdownTimer(state: context.state)
                    .font(.caption2.monospacedDigit())
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: "timer")
            }
        }
    }
}

/// The lock screen: the set on now and the stage, then when it's due off and
/// what's next, with the timer beside them.
struct CountdownLockScreen: View {
    let stage: String
    let state: CountdownAttributes.ContentState
    let stale: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                CountdownLines(state: state, stale: stale)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            CountdownTimer(state: state)
                .font(.title2.monospacedDigit().bold())
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 110, alignment: .trailing)
        }
    }

    private var title: String {
        if let onNow = state.onNow { return "\(onNow.name) on \(stage)" }
        return stage
    }
}

/// "Off at 22:26 · The Hollows next at 22:56", as on Android; or, past the
/// point where the phone last heard, a line saying to open crewbox.
struct CountdownLines: View {
    let state: CountdownAttributes.ContentState
    let stale: Bool

    var body: some View {
        if stale {
            // Past staleDate the running order may have moved without this
            // phone hearing: nothing but the app can update this.
            Text("Open crewbox for the running order")
                .lineLimit(2)
        } else {
            Text(line)
                .lineLimit(2)
        }
    }

    /// One interpolated Text, so each time is drawn in the phone's own
    /// 12- or 24-hour style.
    private var line: LocalizedStringKey {
        switch (state.onNow, state.next) {
        case let (onNow?, next?):
            if let end = onNow.end {
                return "Off at \(end, style: .time) · \(next.name) next at \(next.start, style: .time)"
            }
            return "On now · \(next.name) next at \(next.start, style: .time)"
        case let (onNow?, nil):
            if let end = onNow.end { return "Off at \(end, style: .time)" }
            return "On now"
        case let (nil, next?):
            return "\(next.name) next at \(next.start, style: .time)"
        case (nil, nil):
            return ""
        }
    }
}

/// Counts down to the target and then, past it, up: `.timer` does both.
struct CountdownTimer: View {
    let state: CountdownAttributes.ContentState

    var body: some View {
        if let target = state.target {
            Text(target, style: .timer)
        } else {
            Text("On now")
        }
    }
}

/// The stage's initials for the Dynamic Island's narrow corner: "MS" for
/// "Main Stage".
func initials(_ stage: String) -> String {
    let letters = stage.split(separator: " ").compactMap(\.first).prefix(2)
    return letters.isEmpty ? "" : String(letters).uppercased()
}

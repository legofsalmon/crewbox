import Capacitor
import UIKit
import UserNotifications

/// Lock-screen alerts on the iPhone, as `window.Capacitor.Plugins.CrewboxAlerts`,
/// the name the Android app's plugin has, so the page calls one plugin on both.
///
/// `start` is called by the page after each welcome from a box. The first
/// time, it asks for permission to notify; the page says why just before
/// (web/src/store.ts). Nothing here connects to a box yet: that is the Local
/// Push provider's job, once Apple grants the entitlement. `setCountdown`
/// and `getCountdown` put a followed stage's countdown on the lock screen.
///
/// The app never requires notifications (App Review guidelines 4.5.4 and
/// 5.1.2(i)): a refusal leaves everything else working, and the alert
/// settings say that alerts are off, with a way to Settings.
@objc(AlertsPlugin)
public class AlertsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AlertsPlugin"
    public let jsName = "CrewboxAlerts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notificationState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCountdown", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCountdown", returnType: CAPPluginReturnPromise),
    ]

    @objc func start(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else {
                call.resolve()
                return
            }
            // Alerts, sounds and the badge. Not provisional, which delivers
            // quietly, and not the deprecated .timeSensitive option: the
            // capability is what makes an alert Time Sensitive.
            center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                call.resolve()
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// `granted`, `denied` or `ask`: whether the page should say alerts are off.
    @objc func notificationState(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                call.resolve(["state": "ask"])
            case .denied:
                call.resolve(["state": "denied"])
            default:
                call.resolve(["state": "granted"])
            }
        }
    }

    /// The app's notification settings, where a refusal is undone.
    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let link: String
            if #available(iOS 16.0, *) {
                link = UIApplication.openNotificationSettingsURLString
            } else {
                link = UIApplication.openSettingsURLString
            }
            guard let url = URL(string: link) else {
                call.resolve()
                return
            }
            UIApplication.shared.open(url) { _ in call.resolve() }
        }
    }

    /// Put a followed stage's countdown on the lock screen as a Live
    /// Activity, or take it off with `stage: null`. On the iPhone the page
    /// also sends what to show, `countdown`, the box's `StageCountdown` for
    /// that stage worked out from its own running order (LiveCountdown).
    @objc func setCountdown(_ call: CAPPluginCall) {
        let stage = call.getString("stage")?.trimmingCharacters(in: .whitespaces)
        let content = call.getObject("countdown").map(Self.content)
        Task {
            let shown = await LiveCountdown.set(stage: stage, content: content)
            call.resolve(Self.stageResult(shown))
        }
    }

    /// The stage whose countdown is on the lock screen, or null.
    @objc func getCountdown(_ call: CAPPluginCall) {
        call.resolve(Self.stageResult(LiveCountdown.stage))
    }

    private static func stageResult(_ stage: String?) -> JSObject {
        guard let stage else { return ["stage": NSNull()] }
        return ["stage": stage]
    }

    /// The page's `StageCountdown` (shared/src/alerts.ts), its instants in
    /// epoch milliseconds.
    static func content(_ countdown: JSObject) -> CountdownAttributes.ContentState {
        func slot(_ key: String) -> CountdownAttributes.Slot? {
            guard let set = countdown[key] as? JSObject,
                  let name = set["name"] as? String,
                  let start = milliseconds(set["start"])
            else { return nil }
            return CountdownAttributes.Slot(name: name, start: start, end: milliseconds(set["end"]))
        }
        return CountdownAttributes.ContentState(onNow: slot("onNow"), next: slot("next"))
    }

    private static func milliseconds(_ value: Any?) -> Date? {
        guard let number = value as? NSNumber else { return nil }
        return Date(timeIntervalSince1970: number.doubleValue / 1000)
    }
}

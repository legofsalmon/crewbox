import Capacitor
import UIKit
import UserNotifications

/// crewbox's own notification delegate, in place of Capacitor's.
///
/// Capacitor's NotificationRouter is the delegate by default, and with no
/// notifications plugin installed it shows nothing while the app is open and
/// drops every tap. So `ios.handleApplicationNotifications` is off in
/// capacitor.config.ts, and this is set in `didFinishLaunching`, before
/// Apple's deadline for a delegate that is to hear a tap that launched the
/// app.
///
/// What it reads from a notification, which the alerts provider sets on
/// each one it posts (docs/ALERTS.md):
/// - `kind`: the alert's kind. While the app is on screen, a show stop or a
///   changeover call still shows as a banner; the page announces the rest
///   with its own banner and chirp, as it does on Android.
/// - `link`: a `crewbox://open` link, where a tap goes. It is handed to the
///   page the way a `crewbox://join` link is, once the bridge's view has
///   appeared, so a tap that started the app isn't lost before the page
///   listens (web/src/lib/appLinks.ts).
final class AlertsNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AlertsNotifications()

    /// The kinds that show while the app is on screen.
    static let shownInApp: Set<String> = ["showStop", "changeover"]

    private var bridgeReady = false
    private var waiting: [URL] = []

    func install() {
        UNUserNotificationCenter.current().delegate = self
        NotificationCenter.default.addObserver(
            forName: .capacitorViewDidAppear, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.bridgeReady = true
            let links = self.waiting
            self.waiting = []
            links.forEach(self.open)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let kind = notification.request.content.userInfo["kind"] as? String ?? ""
        completionHandler(AlertsNotifications.shownInApp.contains(kind) ? [.banner, .list, .sound] : [])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let link = response.notification.request.content.userInfo["link"] as? String,
              let url = URL(string: link), url.scheme == "crewbox" else { return }
        if bridgeReady {
            open(url)
        } else {
            waiting.append(url)
        }
    }

    private func open(_ url: URL) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }
}

import UIKit
import Capacitor

/// The app's one window, under the scene life cycle.
///
/// Apple's TN3187: in the next major release after iOS 26, an app built with
/// the latest SDK won't launch without the UIScene life cycle. Capacitor 8
/// has no scene support of its own, so this hands the scene's links to
/// Capacitor exactly as the app delegate did: `crewbox://join` from a poster
/// or a message, and `crewbox://open` from a tapped alert. The window itself
/// still comes from Main.storyboard, named in Info.plist's scene manifest.
///
/// A link that starts the app arrives in the connection options, not in
/// `openURLContexts`. Capacitor's plugins aren't loaded yet then, so it is
/// handed on once the bridge's view has appeared, as Capacitor 8.5's own
/// `SceneDelegateProxy` does; the App plugin keeps it for the page
/// (web/src/lib/appLinks.ts). This app is on Capacitor 8.4, which has no
/// scene proxy; moving to 8.5 can replace this class's body with calls to it.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        let urls = connectionOptions.urlContexts
        let activities = connectionOptions.userActivities
        if urls.isEmpty && activities.isEmpty { return }
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(
            forName: .capacitorViewDidAppear, object: nil, queue: .main
        ) { [weak self] _ in
            if let token { NotificationCenter.default.removeObserver(token) }
            for context in urls {
                self?.open(context)
            }
            for activity in activities {
                _ = ApplicationDelegateProxy.shared.application(
                    UIApplication.shared, continue: activity, restorationHandler: { _ in })
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            open(context)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }

    private func open(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: context.options.openInPlace
        ]
        if let source = context.options.sourceApplication {
            options[.sourceApplication] = source
        }
        if let annotation = context.options.annotation {
            options[.annotation] = annotation
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared, open: context.url, options: options)
    }
}

import Capacitor
import UIKit

/// The app's web view, with crewbox's own Swift plugins on its bridge.
///
/// Capacitor registers the plugins that come from npm packages by itself,
/// from a list `cap sync` rewrites, but not ones that live in this target.
/// Main.storyboard names this class in place of CAPBridgeViewController.
class CrewboxViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // Which screens the first page loads, before it loads anything: those
        // its event last started with, when this build still runs them. The
        // app's own are named too, so that a path anything else once saved
        // for Capacitor can't take their place.
        let launch = Screens.chooseAtLaunch()
        bridge?.setServerBasePath((launch.folder ?? Screens.ownFolder()).path)

        bridge?.registerPluginInstance(DiscoveryPlugin())
        bridge?.registerPluginInstance(ScannerPlugin())
        bridge?.registerPluginInstance(WifiPlugin())
        bridge?.registerPluginInstance(SessionsPlugin())
        bridge?.registerPluginInstance(RecordsPlugin())
        bridge?.registerPluginInstance(AlertsPlugin())
        let screens = ScreensPlugin()
        screens.launched = launch
        bridge?.registerPluginInstance(screens)
    }
}

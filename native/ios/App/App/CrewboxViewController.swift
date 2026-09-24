import Capacitor
import UIKit

/// The app's web view, with crewbox's own Swift plugins on its bridge.
///
/// Capacitor registers the plugins that come from npm packages by itself,
/// from a list `cap sync` rewrites, but not ones that live in this target.
/// Main.storyboard names this class in place of CAPBridgeViewController.
class CrewboxViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DiscoveryPlugin())
    }
}

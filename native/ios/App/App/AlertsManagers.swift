import Foundation
import NetworkExtension

/// The Local Push managers, one per Wi-Fi name, each listing the boxes the
/// phone is signed in to on that Wi-Fi (docs/ALERTS.md).
///
/// iOS starts the provider when the phone joins a network whose name a
/// manager lists. A name saved in a second manager switches the first off,
/// so there is only ever one per name, found again from the preferences
/// rather than recreated. Each is saved only when something changed: a save
/// that changes nothing is reported to fail.
///
/// All of it needs the Local Push Connectivity entitlement, which Apple
/// grants on request. Without it every load and save fails, quietly: the app
/// works as before, with no lock-screen alerts.
enum AlertsManagers {
    /// The box the page last started alerts for, so `stop` knows which to
    /// take off its manager. A storage name on phones.
    private static let currentKey = "crewbox.alerts.current"

    /// List `box` on `ssid`'s manager, and off any other.
    static func add(_ box: AlertsBox, ssid: String) {
        UserDefaults.standard.set(box.entry, forKey: currentKey)
        NEAppPushManager.loadAllFromPreferences { managers, _ in
            let managers = managers ?? []
            for manager in managers where !(manager.matchSSIDs.contains(ssid)) {
                if AlertsBox.list(in: manager.providerConfiguration).contains(where: { $0.origin == box.origin }) {
                    remove(box, from: manager)
                }
            }
            let manager = managers.first { $0.matchSSIDs.contains(ssid) } ?? NEAppPushManager()
            var boxes = AlertsBox.list(in: manager.providerConfiguration)
            boxes.removeAll { $0.origin == box.origin || $0.session == box.session }
            boxes.append(box)
            let configuration = AlertsBox.configuration(boxes)
            let unchanged = manager.matchSSIDs == [ssid]
                && manager.isEnabled
                && manager.providerBundleIdentifier == AlertsShared.providerBundleId
                && AlertsBox.list(in: manager.providerConfiguration) == boxes
            guard !unchanged else { return }
            manager.localizedDescription = "Crewbox alerts on \(ssid)"
            manager.providerBundleIdentifier = AlertsShared.providerBundleId
            manager.matchSSIDs = [ssid]
            manager.providerConfiguration = configuration
            manager.isEnabled = true
            manager.saveToPreferences { _ in }
        }
    }

    /// Take the box `start` last listed off its manager: the person signed out.
    static func removeCurrent() {
        guard let entry = UserDefaults.standard.dictionary(forKey: currentKey),
              let box = AlertsBox(entry)
        else { return }
        UserDefaults.standard.removeObject(forKey: currentKey)
        NEAppPushManager.loadAllFromPreferences { managers, _ in
            for manager in managers ?? [] {
                if AlertsBox.list(in: manager.providerConfiguration).contains(where: { $0.origin == box.origin }) {
                    remove(box, from: manager)
                }
            }
        }
    }

    /// Off one manager; the manager goes with its last box.
    private static func remove(_ box: AlertsBox, from manager: NEAppPushManager) {
        let boxes = AlertsBox.list(in: manager.providerConfiguration).filter { $0.origin != box.origin }
        if boxes.isEmpty {
            manager.removeFromPreferences { _ in }
        } else {
            manager.providerConfiguration = AlertsBox.configuration(boxes)
            manager.saveToPreferences { _ in }
        }
    }
}

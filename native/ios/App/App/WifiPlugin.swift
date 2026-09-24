import Capacitor
import Foundation
import NetworkExtension

/// Joins the Wi-Fi network in a `WIFI:` code the scanner read, for the join
/// screen (web/src/components/Join.tsx), as `window.Capacitor.Plugins.CrewboxWifi`.
///
/// NEHotspotConfiguration adds the network to the phone's own, as joining it
/// in Settings would, once iOS has asked the crew member, and iOS joins it if
/// it is nearby. It stays until the app is deleted, which takes it with it.
/// iOS's answer says only that the configuration went in, not that the phone
/// is on the network: out of range and a wrong password answer the same
/// (Apple's documentation of `apply`). So the plugin then asks which network
/// the phone is on, each second for a few seconds while it joins. An app may
/// read that only for a network it configured itself (or with location, which
/// this one doesn't ask for), and only with the Access Wi-Fi Information
/// entitlement: any other network reads as none, so the app learns nothing of
/// the phone's other networks.
///
/// `join` resolves with what happened: `joined`, also when the phone was on
/// the network already; `declined` when turned down; `failed` when the phone
/// isn't seen on it after the wait, most likely out of range or a wrong
/// password; `invalid` for a name or password iOS won't take; and
/// `unavailable` for anything else iOS refuses with, such as a network a
/// profile manages or its unexplained internal error, when the join screen
/// points to the Camera app and the Wi-Fi settings instead.
///
/// There is no WPA3 setting (Apple's support staff call that a known
/// limitation), so a network goes to iOS the same way whether it is WPA2,
/// WPA2/WPA3 or WPA3 alone, and iOS doesn't document joining the last.
@objc(WifiPlugin)
public class WifiPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WifiPlugin"
    public let jsName = "CrewboxWifi"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "join", returnType: CAPPluginReturnPromise),
    ]

    /// How many times, a second apart, the phone is looked at for the network.
    private static let checks = 10

    @objc func join(_ call: CAPPluginCall) {
        let ssid = call.getString("ssid") ?? ""
        let password = call.getString("password") ?? ""
        // One configuration for WPA2 and WPA3 alike: it has no setting for which.
        let configuration = password.isEmpty
            ? NEHotspotConfiguration(ssid: ssid)
            : NEHotspotConfiguration(ssid: ssid, passphrase: password, isWEP: false)
        // Kept, as a network joined in Settings is, so the phone goes back to it.
        configuration.joinOnce = false
        configuration.hidden = call.getBool("hidden") ?? false
        NEHotspotConfigurationManager.shared.apply(configuration) { error in
            DispatchQueue.main.async {
                if let error = error as NSError? {
                    call.resolve(["result": WifiPlugin.outcome(of: error)])
                } else {
                    self.confirm(ssid, call, checksLeft: WifiPlugin.checks)
                }
            }
        }
    }

    private static func outcome(of error: NSError) -> String {
        guard error.domain == NEHotspotConfigurationErrorDomain,
              let code = NEHotspotConfigurationError(rawValue: error.code)
        else { return "unavailable" }
        switch code {
        case .alreadyAssociated:
            return "joined"
        case .userDenied:
            return "declined"
        case .invalid, .invalidSSID, .invalidWPAPassphrase:
            return "invalid"
        default:
            return "unavailable"
        }
    }

    /// Whether the phone is on the network yet: `fetchCurrent` answers on the main thread.
    private func confirm(_ ssid: String, _ call: CAPPluginCall, checksLeft: Int) {
        NEHotspotNetwork.fetchCurrent { network in
            if network?.ssid == ssid {
                call.resolve(["result": "joined"])
            } else if checksLeft <= 1 {
                call.resolve(["result": "failed"])
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.confirm(ssid, call, checksLeft: checksLeft - 1)
                }
            }
        }
    }
}

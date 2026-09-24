import Capacitor
import Foundation
import Security

/// The app's sign-ins, one session token per event under the name the page
/// gives it (web/src/lib/sessions.ts), kept in the Keychain rather than the
/// web view's storage, as `window.Capacitor.Plugins.CrewboxSessions`.
///
/// The web view's storage goes with an iCloud or computer backup to a new
/// iPhone, and a sign-in made on one phone should not arrive on another. An
/// item that is `ThisDeviceOnly` never goes to another phone: not from a
/// backup, not by iCloud Keychain, which only takes items marked
/// synchronizable, and these aren't. `AfterFirstUnlock` is readable once the
/// phone has been unlocked since it started, which the page always has been,
/// and which a Local Push Connectivity provider running with the phone locked
/// would need too (Phase 4 of the plan). That provider is an extension, so it
/// will need these moved to a Keychain access group the two share: items
/// here are in the app's own, which is the one it has without the
/// keychain-access-groups entitlement.
///
/// The Keychain outlives the app: delete it and install it again, and these
/// are still here while the page's storage is not. The page drops any the
/// page's storage doesn't name when it loads them, so that never signs a
/// fresh install in.
@objc(SessionsPlugin)
public class SessionsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SessionsPlugin"
    public let jsName = "CrewboxSessions"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    /// The Keychain service the sign-ins are under. It reaches phones:
    /// renaming it strands every sign-in on them.
    static let service = "com.colmhewson.crewbox.sessions"

    /// Every sign-in, by name. Rejects, and the page deletes nothing, when
    /// the Keychain won't say: before the phone's first unlock, for one.
    @objc func load(_ call: CAPPluginCall) {
        var names: CFTypeRef?
        let listed = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SessionsPlugin.service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ] as CFDictionary, &names)
        if listed == errSecItemNotFound {
            call.resolve(["sessions": [String: String]()])
            return
        }
        guard listed == errSecSuccess else {
            call.reject("The Keychain answered \(listed)")
            return
        }
        // Then each one's token by its name, one search per item, the plain
        // form of the search: there are only ever a few.
        var sessions: [String: String] = [:]
        for item in (names as? [[String: Any]]) ?? [] {
            guard let name = item[kSecAttrAccount as String] as? String else { continue }
            var data: CFTypeRef?
            let read = SecItemCopyMatching([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: SessionsPlugin.service,
                kSecAttrAccount as String: name,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecReturnData as String: true,
            ] as CFDictionary, &data)
            if read == errSecItemNotFound { continue }
            guard read == errSecSuccess else {
                call.reject("The Keychain answered \(read)")
                return
            }
            if let bytes = data as? Data, let token = String(data: bytes, encoding: .utf8) {
                sessions[name] = token
            }
        }
        call.resolve(["sessions": sessions])
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty,
              let token = call.getString("token"), !token.isEmpty
        else {
            call.reject("A name and a token are needed")
            return
        }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SessionsPlugin.service,
            kSecAttrAccount as String: name,
        ]
        // Replaced whole, so it always has the accessibility below, whatever
        // an earlier item under the name had.
        SecItemDelete(item as CFDictionary)
        var added = item
        added[kSecValueData as String] = Data(token.utf8)
        added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(added as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("The Keychain answered \(status)")
        }
    }

    @objc func forget(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("A name is needed")
            return
        }
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SessionsPlugin.service,
            kSecAttrAccount as String: name,
        ] as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("The Keychain answered \(status)")
        }
    }
}

import Capacitor
import Foundation
import Security

/// The app's sign-ins, one session token per event under the name the page
/// gives it (web/src/lib/sessions.ts), kept in the Keychain rather than the
/// web view's storage, as `window.Capacitor.Plugins.CrewboxSessions`.
///
/// The web view's storage goes with an iCloud or computer backup to a new
/// iPhone, and a sign-in made on one phone should not arrive on another. An
/// item that is `ThisDeviceOnly` doesn't go to another phone in a backup,
/// Apple documents, nor by iCloud Keychain, which only takes items marked
/// synchronizable, and these aren't. Quick Start's transfer straight from
/// the old iPhone may be another matter. Apple's DTS has said it carries the
/// Keychain across, without having tried it with these, and developers have
/// reported `ThisDeviceOnly` items arriving that way (Apple Developer Forums
/// threads 809943, 112555 and 675927). Nobody has tried it with this app.
/// It needs both phones side by side, so it is somebody moving to a new
/// phone of their own, signed in as they were.
///
/// `AfterFirstUnlock` is readable once the phone has been unlocked since it
/// started, which the page always has been, and which the Local Push
/// provider running with the phone locked needs too (docs/ALERTS.md). That
/// provider is an extension, a separate executable, so the sign-ins are kept
/// in the App Group the two share, `group.com.colmhewson.crewbox`, which
/// also works as a Keychain group. An App Group is never the default group,
/// so everything added here names it, and nothing else the app keeps moves.
/// Sign-ins from before it were in the app's own group; `load` moves them
/// (`moveIntoAppGroup`).
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

    /// The App Group the app shares with its Local Push provider, as a
    /// Keychain group. It reaches phones: never renamed.
    static let appGroup = "group.com.colmhewson.crewbox"

    /// Every sign-in, by name. Rejects, and the page deletes nothing, when
    /// the Keychain won't say: before the phone's first unlock, for one.
    @objc func load(_ call: CAPPluginCall) {
        SessionsPlugin.moveIntoAppGroup()
        // Every search here names no group, so it finds a sign-in wherever
        // it is: one not moved yet (before the first unlock, say) is still
        // read, and still changed or forgotten in place.
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
        let data = Data(token.utf8)
        // Changed in place, as Apple's DTS advises, not deleted and added
        // again: a delete needs nothing the phone might not have to hand, so
        // an add that then failed left no sign-in at all. The accessibility is
        // set when an item is added and never changed (DTS again), so every
        // item has the one below: this is the only code that adds them.
        var status = SecItemUpdate(
            item as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var added = item
            added[kSecValueData as String] = data
            added[kSecAttrAccessGroup as String] = SessionsPlugin.appGroup
            added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(added as CFDictionary, nil)
            if status == errSecMissingEntitlement {
                // A build signed without the App Group, as CI's is: the
                // app's own group, as before, rather than no sign-in.
                added.removeValue(forKey: kSecAttrAccessGroup as String)
                status = SecItemAdd(added as CFDictionary, nil)
            }
        }
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

    /// Moves each sign-in kept in the app's own Keychain group into the App
    /// Group, where the Local Push provider can read it.
    ///
    /// A copy is added first, with the same protection, and read back; only
    /// then is the old one deleted, naming its own group. A delete that named
    /// no group would search them all and take the new copy too. Apple
    /// doesn't say whether an update can move an item between groups, so
    /// none does. Anything that fails leaves the sign-in where it was, to be
    /// moved on a later load: before the phone's first unlock, or in a build
    /// signed without the App Group.
    static func moveIntoAppGroup() {
        var found: CFTypeRef?
        guard SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ] as CFDictionary, &found) == errSecSuccess else { return }
        for item in (found as? [[String: Any]]) ?? [] {
            guard let name = item[kSecAttrAccount as String] as? String,
                  let group = item[kSecAttrAccessGroup as String] as? String,
                  group != appGroup
            else { continue }
            let old: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: name,
                kSecAttrAccessGroup as String: group,
            ]
            var shared = old
            shared[kSecAttrAccessGroup as String] = appGroup
            guard let token = data(of: old) else { continue }

            var copy = shared
            copy[kSecValueData as String] = token
            copy[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            var status = SecItemAdd(copy as CFDictionary, nil)
            if status == errSecDuplicateItem {
                // Copied once before, and the delete never happened.
                status = SecItemUpdate(
                    shared as CFDictionary, [kSecValueData as String: token] as CFDictionary)
            }
            guard status == errSecSuccess, data(of: shared) == token else { continue }
            SecItemDelete(old as CFDictionary)
        }
    }

    /// One item's data, or nil when the Keychain won't give it.
    private static func data(of item: [String: Any]) -> Data? {
        var query = item
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var data: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &data) == errSecSuccess else { return nil }
        return data as? Data
    }
}

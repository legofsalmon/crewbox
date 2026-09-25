import Capacitor
import Foundation

/// The app's copy of what the page keeps for each event (web/src/lib/appCopy.ts),
/// in files of the app's own, as `window.Capacitor.Plugins.CrewboxRecords`.
///
/// The web view's storage can go without anyone asking: WebKit's tracking
/// prevention deletes all of it once the app has gone 7 days of use without a
/// tap on iOS 17, or 30 on iOS 18 and later, open page or not. These files
/// aren't the web view's, so they stay.
///
/// A folder per event, by its ID, and a file per slot, each replaced whole:
/// `Library/Application Support/crewbox-records/<event>/<slot>`. The folder's
/// name and each slot's reach phones: renaming one strands every copy on them.
///
/// Kept out of backups, as the sign-ins are (SessionsPlugin): what they hold
/// is one phone's. The mark is on the folder, which is how Apple says to keep
/// a group of files out ("Optimizing Your App's Data for iCloud Backup"): one
/// on each file wouldn't last, since an atomic write makes a new file and
/// moves it in. It is set again at every call, in case anything has reset it.
/// Apple says the mark is only guidance, so a restored phone may bring them
/// back, with the page's storage they were copied from. They hold no token,
/// so they sign nothing in. Deleting the app deletes them, unlike the
/// Keychain, which is how the page tells a wipe of its storage from an app
/// installed again.
///
/// Readable once the phone has been unlocked since it started, like the
/// sign-ins: the page always has been. Capacitor calls each method in turn on
/// its own queue, so one write never meets another.
@objc(RecordsPlugin)
public class RecordsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RecordsPlugin"
    public let jsName = "CrewboxRecords"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    /// The folder every event's is in, in Application Support. It reaches phones.
    static let folder = "crewbox-records"

    /// An event ID as the page files data under (eventScope.ts `eventIdFrom`).
    static func isEvent(_ value: String) -> Bool {
        value.range(of: #"\A[0-9A-Za-z_]{1,64}\z"#, options: .regularExpression) != nil
    }

    /// A slot: nothing that climbs out of its folder, or starts with a dot.
    static func isSlot(_ value: String) -> Bool {
        value.range(of: #"\A[0-9A-Za-z_][0-9A-Za-z_-]{0,63}\z"#, options: .regularExpression) != nil
    }

    /// The folder, made when it isn't there yet, and marked to stay out of backups.
    static func root() throws -> URL {
        var root = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent(RecordsPlugin.folder, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        return root
    }

    /// Every event's copy of one slot, by event ID. Throws rather than leaving
    /// one out when a file won't read.
    static func readAll(slot: String, in root: URL) throws -> [String: String] {
        let events = try FileManager.default.contentsOfDirectory(atPath: root.path)
        var values: [String: String] = [:]
        for event in events where isEvent(event) {
            let file = root.appendingPathComponent(event, isDirectory: true)
                .appendingPathComponent(slot, isDirectory: false)
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            let data = try Data(contentsOf: file)
            values[event] = String(decoding: data, as: UTF8.self)
        }
        return values
    }

    /// Keep one slot of an event's, in place of what was there. Written beside
    /// it and moved over it, so a phone that dies halfway has the old copy or
    /// the new one, never half of one. ScreensPlugin keeps one slot here too.
    static func keep(_ value: String, event: String, slot: String) throws {
        let folder = try root().appendingPathComponent(event, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(value.utf8).write(
            to: folder.appendingPathComponent(slot, isDirectory: false),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Every event's copy of one slot, by event ID. Rejects rather than leaving
    /// one out when a file won't read: the page takes a copy with an event
    /// missing as that event forgotten, and signs the phone out of it.
    @objc func readAll(_ call: CAPPluginCall) {
        guard let slot = call.getString("slot"), RecordsPlugin.isSlot(slot) else {
            call.reject("A slot is needed")
            return
        }
        do {
            let values = try RecordsPlugin.readAll(slot: slot, in: RecordsPlugin.root())
            call.resolve(["values": values])
        } catch {
            call.reject("The app's files answered \(error)")
        }
    }

    /// Keep one slot of an event's, in place of what was there.
    @objc func write(_ call: CAPPluginCall) {
        guard let event = call.getString("event"), RecordsPlugin.isEvent(event),
              let slot = call.getString("slot"), RecordsPlugin.isSlot(slot),
              let value = call.getString("value")
        else {
            call.reject("An event, a slot and a value are needed")
            return
        }
        do {
            try RecordsPlugin.keep(value, event: event, slot: slot)
            call.resolve()
        } catch {
            call.reject("The app's files answered \(error)")
        }
    }

    /// Forget one slot of an event's, or everything of the event's without one.
    @objc func remove(_ call: CAPPluginCall) {
        let slot = call.getString("slot")
        guard let event = call.getString("event"), RecordsPlugin.isEvent(event),
              slot.map(RecordsPlugin.isSlot) ?? true
        else {
            call.reject("An event is needed")
            return
        }
        do {
            var target = try RecordsPlugin.root().appendingPathComponent(event, isDirectory: true)
            if let slot = slot {
                target = target.appendingPathComponent(slot, isDirectory: false)
            }
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            call.resolve()
        } catch {
            call.reject("The app's files answered \(error)")
        }
    }
}

import Capacitor
import CryptoKit
import Foundation
import UIKit
import WebKit

/// The screens a box serves, downloaded and checked before the app runs any
/// of them, as `window.Capacitor.Plugins.CrewboxScreens`.
///
/// The app has one origin for every event the phone has been to, so code
/// running in it can read every event's chat, documents and sign-ins. Until
/// now all of that code came in the app. A box's screens are to run there only
/// when a crewbox release signed them: the list of their files, `WEBSUMS`, is
/// signed with the key that signs the boxes' own updates
/// (scripts/sign-web.mjs), checked here against the public keys this build
/// carries, and every file is checked against the list. Screens from anywhere
/// else, such as a development box or a fork, leave the app on its own.
///
/// The rules are the release's (scripts/web-sums.mjs), as Screens.java has
/// them on Android. screens-fixtures.json holds the release and the Android
/// app to the same answers; this app has no test target yet, so a server test
/// holds its names, limits and keys to theirs.
///
/// Each version's screens are kept in a folder named after it,
/// `Library/Application Support/crewbox-screens/<version>/`, marked to stay
/// out of backups: the box has them. A download goes into a folder beside it
/// and is moved into place once every file has been checked, so a folder with
/// a version's name is a whole set. Its `.checked` mark is the digest of the
/// list it was checked against. These names reach phones: renaming one
/// strands what is kept.
///
/// CrewboxViewController chooses what a start runs before the first page
/// loads (Screens.chooseAtLaunch). While the app runs, the page switches only
/// by asking (`use`), and then reloads itself, which keeps its address.
/// Downloaded screens that don't say they started (`ready`) within
/// `readyWithinSeconds` of loading, with the app in front, have failed: the
/// app goes back to its own, and reloads. Each time the app comes back in
/// front they have that long again, since out of sight the page may not run
/// at all. The folder of the screens running is never changed until the next
/// start.
///
/// Everything but the web view's own calls runs on a queue of the plugin's,
/// one thing at a time, and so does its state. A download can take a while,
/// and Capacitor calls each plugin's methods in turn on one queue.
@objc(ScreensPlugin)
public class ScreensPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreensPlugin"
    public let jsName = "CrewboxScreens"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "use", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
    ]

    /// What this start runs, chosen before the plugin loads (CrewboxViewController).
    var launched: Screens.Launch?

    private let queue = DispatchQueue(label: "crewbox-screens")

    /// This build, as Screens checks against it. On the queue, as is all that follows.
    private var app = Screens.App.thisBuild(builtIn: nil)

    /// The version of the screens running, or nil when the app's own can't say.
    private var running: String?

    /// The event a switch was for, which starts with the screens it switched to once they say they started.
    private var switchedFor: String?

    /// Which wait for `ready` is the current one: a timer from any other does nothing.
    private var waiting = 0

    /// Whether downloaded screens are loading that haven't said they started.
    private var awaiting = false

    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let launch = launched
        observers = [
            NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.backInFront()
            },
        ]
        queue.async {
            self.app = Screens.App.thisBuild(builtIn: Screens.builtIn())
            self.running = launch?.version ?? self.app.builtIn
            if launch?.folder != nil { self.waitForReady() }
            if let root = try? Screens.root() {
                let records = try? RecordsPlugin.root()
                let keep = records.flatMap {
                    Screens.inUse(root: root, records: $0, app: self.app, running: self.running)
                }
                Screens.sweep(root, keep: keep)
            }
        }
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private func backInFront() {
        queue.async {
            if self.awaiting { self.waitForReady() }
        }
    }

    /// Whether the app is in front, where the page runs. On the main queue.
    private func inFront() -> Bool {
        UIApplication.shared.applicationState != .background
    }

    /// On the queue: give the screens that are loading `readyWithinSeconds`
    /// in front to say they started. Out of sight when it runs out, the wait
    /// begins again once the app is back (backInFront).
    private func waitForReady() {
        waiting += 1
        awaiting = true
        let wait = waiting
        let deadline = DispatchTime.now() + .seconds(Screens.readyWithinSeconds)
        DispatchQueue.main.asyncAfter(deadline: deadline) { [weak self] in
            guard let self, self.inFront() else { return }
            self.queue.async { self.waited(wait) }
        }
    }

    private func waited(_ wait: Int) {
        if wait == waiting && awaiting { goBack() }
    }

    /// Downloaded screens that never said they started: the app's own from now on, at once.
    private func goBack() {
        let failed = running
        waiting += 1
        awaiting = false
        switchedFor = nil
        running = app.builtIn
        if let failed, let root = try? Screens.root() {
            // Their start was counted, so the next start fails them.
            try? Screens.failed(root: root, app: app, version: failed)
        }
        DispatchQueue.main.async {
            self.bridge?.setServerBasePath(Screens.ownFolder().path)
            self.bridge?.webView?.reload()
        }
    }

    /// Ask the box at `origin` for its screens, and have them on the phone if
    /// this app runs them. Resolves with the answer, and never rejects for
    /// anything the box or the network does.
    @objc func prepare(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), Screens.isOrigin(origin),
              let base = URL(string: origin + "/")
        else {
            call.reject("A box's address is needed")
            return
        }
        queue.async {
            let answer: Screens.Answer
            do {
                let root = try Screens.root()
                answer = Screens.prepare(
                    box: BoxOverHttp(base: base),
                    root: root,
                    app: self.app,
                    usable: Screens.usableSpace,
                    running: self.running)
            } catch {
                answer = .failed(Screens.describe(error))
            }
            call.resolve(answer.values)
        }
    }

    /// Serve `version` for `event` once the page reloads, which it does as
    /// soon as this resolves: the app's own screens when they are that
    /// version, and otherwise its kept folder, checked again. Rejects, and
    /// changes nothing, when this build won't run them. The event starts with
    /// them from then on once they say they started.
    @objc func use(_ call: CAPPluginCall) {
        guard let event = call.getString("event"), RecordsPlugin.isEvent(event),
              let version = call.getString("version")
        else {
            call.reject("An event and a version are needed")
            return
        }
        queue.async {
            let folder: URL?
            do {
                folder = try Screens.use(root: Screens.root(), app: self.app, version: version)
            } catch {
                call.reject(Screens.describe(error))
                return
            }
            self.switchedFor = event
            self.running = version
            if folder != nil {
                self.waitForReady()
            } else {
                self.waiting += 1
                self.awaiting = false
            }
            DispatchQueue.main.async {
                self.bridge?.setServerBasePath((folder ?? Screens.ownFolder()).path)
                call.resolve()
            }
        }
    }

    /// The page has drawn: screens that say they are `version` started.
    /// Ignored unless they are the screens running, since a page on its way
    /// out can still call.
    @objc func ready(_ call: CAPPluginCall) {
        let version = call.getString("version")
        queue.async {
            guard let version, version == self.running else {
                call.resolve()
                return
            }
            self.waiting += 1
            self.awaiting = false
            let event = self.switchedFor
            self.switchedFor = nil
            if let root = try? Screens.root() {
                // Counted again at the next start, which runs what the event
                // started with before.
                try? Screens.started(root: root, app: self.app, version: version, event: event)
            }
            call.resolve()
        }
    }
}

/// A box, asked for one of its files.
protocol ScreensBox {
    /// Hands the file at `path` on the box to `sink` a piece at a time as it
    /// comes, and answers false when the box answers 404. Throws when the box
    /// doesn't answer, answers anything else but 200, or `sink` throws.
    func fetch(_ path: String, into sink: @escaping (Data) throws -> Void) throws -> Bool
}

/// What the app makes of a box's screens: Screens.java's rules, in Swift.
enum Screens {
    /// The folder every version's screens are kept in, in Application Support.
    static let folder = "crewbox-screens"

    /// What a release calls them (scripts/web-sums.mjs).
    static let sums = "WEBSUMS"
    static let signature = "WEBSUMS.sig"
    static let info = "crewbox-web.json"
    static let kind = "crewbox-web"

    /// Where a box says what it serves (server/src/screens.ts).
    static let offer = "api/app/screens"

    /// The contract with the screens this build's native code keeps: the
    /// plugins it has and what their methods do (web/src/lib/nativeApi.ts).
    /// Raised when a plugin gains a method, or a method changes what it does.
    static let nativeApi = 1

    /// The oldest contract this build still keeps for screens written against it.
    static let oldestScreensApi = 1

    /// The oldest screens this build runs. A release that fixes a hole in the
    /// screens raises it, so no box can hand a phone the hole again.
    static let floor = "1.0.0"

    /// The keys a release signs with, each an Ed25519 public key's 32 bytes in
    /// base64: TRUSTED_KEYS in server/src/update/verify.ts, in the same order
    /// (a server test holds them to it). A new key reaches phones only with an
    /// app update, which has to come before CI signs anything with it.
    static let trustedKeys = [
        // crewbox release key 1, minted 2026-08-13.
        "lijcvU5IzE/rENDWR5WEUdAZ6K2EKjLV61vEDzBseuw=",
    ]

    /// The most a phone takes from a box: LIMITS in scripts/web-sums.mjs.
    static let maxSumsBytes = 64 * 1024
    static let maxFiles = 500
    static let maxBytes = 50 * 1024 * 1024

    /// A box's answer carries the list as JSON; crewbox-web.json is a few lines.
    static let maxOfferBytes = 4 * maxSumsBytes
    static let maxInfoBytes = 64 * 1024

    /// The mark in a version's folder: the digest of the list its files were checked against.
    static let checked = ".checked"

    /// A download on its way: no version is called this, since a version starts with a digit.
    static let partial = ".partial-"

    /// The file beside the versions that counts the starts of downloaded
    /// screens that haven't said they started, and names the versions that
    /// failed, for one build of the app. A new build starts afresh: it may run
    /// what an earlier one couldn't.
    static let launches = ".launches"

    /// Starts that never say they started, after which a version has failed on this build.
    static let maxTries = 2

    /// How long downloaded screens have, with the app in front, to say they
    /// started before the app goes back to its own: twice the 10 seconds
    /// live-update plugins give, since going back wrongly leaves the phone on
    /// screens that may not match its box.
    static let readyWithinSeconds = 20

    /// The slot the page keeps each event's record in (web/src/lib/appCopy.ts).
    static let record = "event"

    /// The slot in each event's records where the app keeps the version of
    /// the screens the event last started with. The app writes it, not the page.
    static let eventSlot = "screens"

    static let maxLaunchesBytes = 64 * 1024
    static let maxRecordBytes = 64 * 1024

    /// A version as crewbox writes one, `1.2.3`, perhaps a pre-release, then
    /// `+` and the commit: isVersion in scripts/web-sums.mjs. It names a
    /// folder, so nothing else gets in.
    static let versionPattern =
        #"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*"#
    static let maxVersionLength = 64

    /// A part of a path a phone writes: safePath in scripts/web-sums.mjs.
    static let segmentPattern = #"[A-Za-z0-9_-][A-Za-z0-9._-]*"#

    /// A box's address as the page gives it: a scheme, a host, perhaps a port, and nothing else.
    static let originPattern = #"https?://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?"#

    /// Why screens weren't taken, in a sentence for the page's log: nothing a
    /// release signed, or not what the box says it runs.
    struct Refused: Error {
        let why: String
        init(_ why: String) { self.why = why }
    }

    /// The network or the phone's storage let the check down; asking again may work.
    struct Failed: Error {
        let why: String
        init(_ why: String) { self.why = why }
    }

    /// What a box says about the screens it serves.
    struct Offer {
        let version: String
        let sums: String
        let signature: String
    }

    /// What crewbox-web.json says the screens are.
    struct Info {
        let version: String
        let proto: Double
        let needs: Double
        let builtFor: Double
    }

    /// What an app build brings to the check.
    struct App {
        let keys: [Data]
        let nativeApi: Int
        let oldestScreensApi: Int
        let floor: String
        /// The version the app's own screens were built as, or nil when it can't be read.
        let builtIn: String?

        /// This build, whose own screens say they are `builtIn`.
        static func thisBuild(builtIn: String?) -> App {
            App(
                keys: Screens.trustedKeys.compactMap(Screens.base64),
                nativeApi: Screens.nativeApi,
                oldestScreensApi: Screens.oldestScreensApi,
                floor: Screens.floor,
                builtIn: builtIn)
        }
    }

    /// What the page is told (CrewboxScreens.prepare in web/src/lib/server.ts).
    struct Answer {
        /// same, ready, unsigned, incompatible or failed.
        let result: String
        /// The version the box runs, when it counts.
        var version: String?
        /// What to update, app or box, when the screens are incompatible.
        var update: String?
        /// Why, for the page's log, when the app keeps its own screens.
        var reason: String?

        /// The box runs the version the app's own screens are: nothing to fetch.
        static func same(_ version: String) -> Answer { Answer(result: "same", version: version) }

        /// The box's screens are on the phone, checked, and this build runs them.
        static func ready(_ version: String) -> Answer { Answer(result: "ready", version: version) }

        /// Nothing a release signed, or not what the box says it runs.
        static func unsigned(_ reason: String) -> Answer { Answer(result: "unsigned", reason: reason) }

        /// Signed screens this build won't run, and what to update so it will.
        static func incompatible(_ version: String, _ update: String) -> Answer {
            Answer(result: "incompatible", version: version, update: update)
        }

        /// The network or the phone's storage let the check down, and asking
        /// again may work; or the screens didn't start on this phone, and
        /// this build runs them no more.
        static func failed(_ reason: String) -> Answer { Answer(result: "failed", reason: reason) }

        var values: [String: Any] {
            var values: [String: Any] = ["result": result]
            if let version = version { values["version"] = version }
            if let update = update { values["update"] = update }
            if let reason = reason { values["reason"] = reason }
            return values
        }
    }

    /// The screens a start runs, and the event it opens.
    struct Launch {
        /// The event this phone opened last, which the page opens, or nil for none.
        let event: String?
        /// The version of the screens, or nil when the app's own can't say what they are.
        let version: String?
        /// The folder they are kept in, or nil for the app's own.
        let folder: URL?
    }

    /// What starts of downloaded screens have shown on one build of the app (`launches`).
    struct Launches {
        let build: String
        /// Starts of each version since it last said it started.
        var tries: [String: Int] = [:]
        /// Versions that didn't start, which this build runs no more.
        var failed: Set<String> = []

        init(build: String) {
            self.build = build
        }

        /// Whether this build runs `version` no more: it failed, or started as
        /// often as it may without saying so.
        func refuses(_ version: String) -> Bool {
            failed.contains(version) || tries[version, default: 0] >= Screens.maxTries
        }

        mutating func fail(_ version: String) {
            tries[version] = nil
            failed.insert(version)
        }
    }

    /// The folder, made when it isn't there yet, and marked to stay out of
    /// backups, as RecordsPlugin's is. The mark is on the folder, so it covers
    /// every version moved into it.
    static func root() throws -> URL {
        var root = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent(folder, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        return root
    }

    /// The folder the app's own screens came in, where Capacitor looks for
    /// them (CAPInstanceDescriptor).
    static func ownFolder() -> URL {
        Bundle.main.url(forResource: "public", withExtension: nil)
            ?? (Bundle.main.resourceURL ?? Bundle.main.bundleURL)
                .appendingPathComponent("public", isDirectory: true)
    }

    /// The version the app's own screens were built as, from the crewbox-web.json they came with.
    static func builtIn() -> String? {
        let file = ownFolder().appendingPathComponent(info, isDirectory: false)
        guard let data = try? readSmall(file, cap: maxInfoBytes) else { return nil }
        return (try? readInfo(data))?.version
    }

    /// The room left for the app's files.
    static func usableSpace() -> Int64 {
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        let values = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? Int64(maxBytes)
    }

    static func describe(_ error: Error) -> String {
        if let refused = error as? Refused { return refused.why }
        if let failed = error as? Failed { return failed.why }
        return error.localizedDescription
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: #"\A(?:"# + pattern + #")\z"#, options: .regularExpression) != nil
    }

    static func isVersion(_ value: String) -> Bool {
        value.utf16.count <= maxVersionLength && matches(value, versionPattern)
    }

    static func isOrigin(_ value: String) -> Bool {
        matches(value, originPattern)
    }

    static func isSafePath(_ path: String) -> Bool {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { matches(String($0), segmentPattern) }
    }

    /// Whether `version` is at or above `floor`, a plain 1.2.3, in the order
    /// semver gives them: a pre-release comes before its release, and the
    /// commit after the + counts for nothing.
    static func atOrAbove(_ version: String, _ floor: String) -> Bool {
        guard let mine = core(version), let least = core(floor) else { return false }
        for part in 0..<3 where mine.numbers[part] != least.numbers[part] {
            return mine.numbers[part] > least.numbers[part]
        }
        return !mine.preRelease
    }

    /// The three numbers a version starts with, and whether a pre-release follows them.
    private static func core(_ version: String) -> (numbers: [Int], preRelease: Bool)? {
        let bytes = Array(version.utf8)
        var at = 0
        var numbers: [Int] = []
        for part in 0..<3 {
            if part > 0 {
                guard at < bytes.count, bytes[at] == UInt8(ascii: ".") else { return nil }
                at += 1
            }
            let start = at
            var number = 0
            while at < bytes.count, at - start < 9, (0x30...0x39).contains(bytes[at]) {
                number = number * 10 + Int(bytes[at] - 0x30)
                at += 1
            }
            guard at > start else { return nil }
            if at < bytes.count, (0x30...0x39).contains(bytes[at]) { return nil }
            numbers.append(number)
        }
        return (numbers, at < bytes.count && bytes[at] == UInt8(ascii: "-"))
    }

    /// Base64 as the release writes it, padded and with nothing else in it,
    /// or nil for anything else. Not Foundation's, whose options skip what it
    /// doesn't know.
    static func base64(_ text: String) -> Data? {
        let chars = Array(text.utf8)
        guard chars.count % 4 == 0 else { return nil }
        var padding = 0
        if chars.last == UInt8(ascii: "=") {
            padding = chars[chars.count - 2] == UInt8(ascii: "=") ? 2 : 1
        }
        var bytes = Data()
        var buffer: UInt32 = 0
        var bits = 0
        for char in chars[0..<(chars.count - padding)] {
            guard let value = sextet(char) else { return nil }
            buffer = (buffer << 6) | UInt32(value)
            bits += 6
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8(truncatingIfNeeded: buffer >> UInt32(bits)))
                buffer &= (UInt32(1) << UInt32(bits)) - 1
            }
        }
        return bytes
    }

    private static func sextet(_ char: UInt8) -> UInt8? {
        switch char {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"): return char - UInt8(ascii: "A")
        case UInt8(ascii: "a")...UInt8(ascii: "z"): return char - UInt8(ascii: "a") + 26
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return char - UInt8(ascii: "0") + 52
        case UInt8(ascii: "+"): return 62
        case UInt8(ascii: "/"): return 63
        default: return nil
        }
    }

    /// ASCII whitespace off both ends, all a phone trims from a signature.
    static func trimAscii(_ text: String) -> String {
        let spaces: Set<Unicode.Scalar> = [" ", "\t", "\n", "\u{0B}", "\u{0C}", "\r"]
        let scalars = Array(text.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end, spaces.contains(scalars[start]) { start += 1 }
        while end > start, spaces.contains(scalars[end - 1]) { end -= 1 }
        var trimmed = String.UnicodeScalarView()
        trimmed.append(contentsOf: scalars[start..<end])
        return String(trimmed)
    }

    /// Which of `keys` signed `message`, or -1 when none did. The signature is
    /// the text of WEBSUMS.sig, trimmed, and has to be base64 of 64 bytes. The
    /// check is over the exact bytes that came: a list read and written out
    /// again could differ by a byte and fail, or worse, pass. CryptoKit
    /// refuses S at or above the group's order (phase3-ed25519.md), and the
    /// lengths are checked here rather than left to it.
    static func signedBy(_ message: Data, _ signature: String, _ keys: [Data]) -> Int {
        guard let bytes = base64(trimAscii(signature)), bytes.count == 64 else { return -1 }
        for (index, key) in keys.enumerated() where key.count == 32 {
            if let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
               publicKey.isValidSignature(bytes, for: message) {
                return index
            }
        }
        return -1
    }

    /// The list, read as strictly as the release reads it: a line that isn't
    /// what sha256sum writes, or a name a phone won't write, refuses the lot.
    /// The files in the order listed, each with its digest.
    static func parseSums(_ sums: Data) throws -> [(path: String, digest: String)] {
        guard sums.count <= maxSumsBytes else { throw Refused("\(Screens.sums) is over \(maxSumsBytes) bytes") }
        guard sums.last == UInt8(ascii: "\n") else { throw Refused("\(Screens.sums) doesn't end in a newline") }
        guard sums.allSatisfy({ $0 < 0x80 }) else { throw Refused("\(Screens.sums) isn't ASCII") }
        var listed: [(path: String, digest: String)] = []
        var seen = Set<String>()
        for line in sums.dropLast().split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false) {
            let bytes = Array(line)
            guard bytes.count > 66, bytes[64] == UInt8(ascii: " "), bytes[65] == UInt8(ascii: " "),
                  bytes[0..<64].allSatisfy(isLowerHex)
            else { throw Refused("unreadable line in \(Screens.sums)") }
            let path = String(decoding: bytes[66...], as: UTF8.self)
            guard isSafePath(path) else { throw Refused("unreadable line in \(Screens.sums)") }
            if path == Screens.sums || path == signature {
                throw Refused("\(Screens.sums) lists \(path), which is no file of the screens")
            }
            if seen.contains(path) { throw Refused("\(path) is listed twice in \(Screens.sums)") }
            if listed.count == maxFiles {
                throw Refused("\(Screens.sums) lists over the \(maxFiles) files a phone takes")
            }
            seen.insert(path)
            listed.append((path: path, digest: String(decoding: bytes[0..<64], as: UTF8.self)))
        }
        return listed
    }

    private static func isLowerHex(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
    }

    /// What a box says about its screens, or Refused when it says nothing a phone reads.
    static func readOffer(_ json: Data) throws -> Offer {
        let offer = try object(json, "the box's answer")
        guard let sums = offer["sums"] as? String, let signature = offer["signature"] as? String else {
            throw Refused("the box's answer has no list and signature")
        }
        guard let version = offer["version"] as? String, isVersion(version) else {
            throw Refused("the box's answer has no version of the form 1.2.3+commit")
        }
        return Offer(version: version, sums: sums, signature: signature)
    }

    /// What crewbox-web.json says, checked as the release checks it (readInfo in web-sums.mjs).
    static func readInfo(_ json: Data) throws -> Info {
        let info = try object(json, Screens.info)
        guard info["kind"] as? String == kind else { throw Refused("\(Screens.info) is not a \(kind) file") }
        guard let version = info["version"] as? String, isVersion(version) else {
            throw Refused("\(Screens.info) has no version of the form 1.2.3+commit")
        }
        let proto = whole(info["protocol"])
        if proto == 0 { throw Refused("\(Screens.info) has no protocol") }
        let contract = info["nativeApi"] as? [String: Any] ?? [:]
        let needs = whole(contract["needs"])
        let builtFor = whole(contract["builtFor"])
        if needs == 0 || builtFor == 0 || needs > builtFor {
            throw Refused("\(Screens.info) has no nativeApi with needs at or below builtFor")
        }
        return Info(version: version, proto: proto, needs: needs, builtFor: builtFor)
    }

    /// Whether this build runs screens that say `info`, from a box that says
    /// it runs `version`: nil when it does, and otherwise what it answers
    /// instead. judge in scripts/web-sums.mjs, which says why each.
    static func judge(_ info: Info, _ version: String, _ app: App) -> Answer? {
        if info.version != version {
            return .unsigned("the box runs \(version) but serves \(info.version)")
        }
        if info.needs > Double(app.nativeApi) { return .incompatible(version, "app") }
        if info.builtFor < Double(app.oldestScreensApi) || !atOrAbove(info.version, app.floor) {
            return .incompatible(version, "box")
        }
        return nil
    }

    /// Ask the box for its screens, and have them on the phone, checked, if
    /// this build runs them. Nothing it does to the phone's storage is seen
    /// unless the whole set checks out. `usable` is the room left for the
    /// app's files, asked for only when a download is needed. `running` is
    /// the version running now, whose folder nothing here changes until the
    /// next start.
    static func prepare(
        box: ScreensBox, root: URL, app: App, usable: () -> Int64, running: String?
    ) -> Answer {
        let offer: Offer
        do {
            guard let answer = try fetch(box, Screens.offer, cap: maxOfferBytes) else {
                return .unsigned("the box has no signed screens")
            }
            offer = try readOffer(answer)
        } catch let refused as Refused {
            return .unsigned(refused.why)
        } catch {
            return .failed(describe(error))
        }
        // Its own screens, which need no check: the app came with them.
        if offer.version == app.builtIn { return .same(offer.version) }

        let sums = Data(offer.sums.utf8)
        let listed: [(path: String, digest: String)]
        do {
            if signedBy(sums, offer.signature, app.keys) < 0 {
                throw Refused("the screens aren't signed with a key this app trusts")
            }
            listed = try parseSums(sums)
        } catch {
            return .unsigned(describe(error))
        }
        guard let infoDigest = listed.first(where: { $0.path == info })?.digest else {
            return .unsigned("\(Screens.sums) doesn't list \(info)")
        }
        if readLaunches(root: root, build: app.builtIn).refuses(offer.version) {
            return .failed("these screens didn't start on this phone")
        }

        let folder = root.appendingPathComponent(offer.version, isDirectory: true)
        if let said = kept(folder, version: offer.version, app: app) {
            return judge(said, offer.version, app) ?? .ready(offer.version)
        }
        // A download would replace the folder the screens running now load from.
        if offer.version == running {
            return .failed("the screens running now aren't as they were checked")
        }
        do {
            // What the screens are first, so nothing more is fetched for
            // screens this build won't run.
            guard let infoData = try fetch(box, info, cap: maxInfoBytes) else {
                return .failed("\(info): not on the box")
            }
            if sha256(infoData) != infoDigest { return .failed("\(info) isn't the file that was signed") }
            let said = try readInfo(infoData)
            if let refused = judge(said, offer.version, app) { return refused }
            if usable() < Int64(maxBytes) {
                return .failed("the phone has less than \(maxBytes / (1024 * 1024)) MB free")
            }
            try download(box, root, offer, listed, infoData)
            return .ready(offer.version)
        } catch let refused as Refused {
            return .unsigned(refused.why)
        } catch {
            return .failed(describe(error))
        }
    }

    /// Every file the list names, each checked as it lands, into a folder of
    /// its own, and then moved into place with the list, its signature and
    /// the mark. A file already in that folder from an earlier try, and still
    /// the one signed, isn't fetched again.
    private static func download(
        _ box: ScreensBox, _ root: URL, _ offer: Offer, _ listed: [(path: String, digest: String)],
        _ infoData: Data
    ) throws {
        let files = FileManager.default
        let partialFolder = root.appendingPathComponent(partial + offer.version, isDirectory: true)
        var total = 0
        for (path, digest) in listed {
            let target = partialFolder.appendingPathComponent(path, isDirectory: false)
            try files.createDirectory(
                at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if isFile(target), (try? sha256(of: target)) == digest {
                total += size(of: target)
            } else if path == info {
                try write(target, infoData)
                total += infoData.count
            } else {
                total += try fetchInto(box, path, target, digest, cap: maxBytes - total)
            }
            if total > maxBytes { throw Failed("the screens are more than a phone takes") }
        }
        let sums = Data(offer.sums.utf8)
        try write(partialFolder.appendingPathComponent(Screens.sums, isDirectory: false), sums)
        try write(
            partialFolder.appendingPathComponent(signature, isDirectory: false),
            Data((trimAscii(offer.signature) + "\n").utf8))
        try write(
            partialFolder.appendingPathComponent(checked, isDirectory: false),
            Data((sha256(sums) + "\n").utf8))
        let folder = root.appendingPathComponent(offer.version, isDirectory: true)
        // Only ever a set that didn't check out, or kept() would have taken it.
        if files.fileExists(atPath: folder.path) { try files.removeItem(at: folder) }
        try files.moveItem(at: partialFolder, to: folder)
    }

    /// The screens kept for `version`, checked again, and what they say; nil
    /// unless all of it holds. The mark has to be the digest of the list
    /// beside it, the list has to verify against this build's keys, and every
    /// file has to be the one it lists.
    static func kept(_ folder: URL, version: String, app: App) -> Info? {
        do {
            let sums = try readSmall(folder.appendingPathComponent(Screens.sums), cap: maxSumsBytes)
            let mark = try readSmall(folder.appendingPathComponent(checked), cap: 128)
            guard mark == Data((sha256(sums) + "\n").utf8) else { return nil }
            let signature = try readSmall(folder.appendingPathComponent(Screens.signature), cap: 1024)
            guard signedBy(sums, String(decoding: signature, as: UTF8.self), app.keys) >= 0 else {
                return nil
            }
            let listed = try parseSums(sums)
            guard listed.contains(where: { $0.path == info }) else { return nil }
            for (path, digest) in listed {
                let file = folder.appendingPathComponent(path, isDirectory: false)
                guard isFile(file), try sha256(of: file) == digest else { return nil }
            }
            let said = try readInfo(readSmall(folder.appendingPathComponent(info), cap: maxInfoBytes))
            return said.version == version ? said : nil
        } catch {
            return nil
        }
    }

    /// Clear away what no start will use: a download that never finished, a
    /// folder whose mark isn't the digest of its list, a version not in
    /// `keep` when that is known, and anything else that isn't a version's
    /// folder or the count of starts.
    static func sweep(_ root: URL, keep: Set<String>?) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else {
            return
        }
        for name in names where name != Screens.launches {
            let entry = root.appendingPathComponent(name)
            if !isVersion(name) || !isDirectory(entry) || !marked(entry)
                || !(keep?.contains(name) ?? true) {
                try? FileManager.default.removeItem(at: entry)
            }
        }
    }

    /// The downloaded screens a start keeps: those running, and those this
    /// phone's events last started with, unless they have failed. None of
    /// them the app's own, which it runs from what it came with. Nil when the
    /// records won't read, and then every whole set is kept.
    static func inUse(root: URL, records: URL, app: App, running: String?) -> Set<String>? {
        var keep = Set<String>()
        if let running { keep.insert(running) }
        do {
            let events = try RecordsPlugin.readAll(slot: record, in: records)
            let launches = readLaunches(root: root, build: app.builtIn)
            for (event, version) in try RecordsPlugin.readAll(slot: eventSlot, in: records)
            where events[event] != nil && !launches.refuses(version) {
                keep.insert(version)
            }
        } catch {
            return nil
        }
        if let builtIn = app.builtIn { keep.remove(builtIn) }
        return keep
    }

    /// The screens the first page loads, before it loads anything (launch).
    /// Never throws: the app's own always start.
    static func chooseAtLaunch() -> Launch {
        let app = App.thisBuild(builtIn: builtIn())
        guard let root = try? Screens.root(), let records = try? RecordsPlugin.root() else {
            return Launch(event: nil, version: app.builtIn, folder: nil)
        }
        return launch(root: root, records: records, app: app)
    }

    /// The screens a start runs: those the event it opens last started with,
    /// when they are kept whole, still check out against this build, and
    /// haven't failed on it; otherwise the app's own. A start of downloaded
    /// screens is counted before the page loads, and the count goes when
    /// they say they started (started): a start that takes the app down
    /// never says so, and after `maxTries` of them the version has failed.
    static func launch(root: URL, records: URL, app: App) -> Launch {
        let event = lastOpened(records: records)
        let own = Launch(event: event, version: app.builtIn, folder: nil)
        guard let event, let version = remembered(records: records, event: event),
              version != app.builtIn
        else { return own }
        var launches = readLaunches(root: root, build: app.builtIn)
        if launches.failed.contains(version) { return own }
        if launches.tries[version, default: 0] >= maxTries {
            launches.fail(version)
            // Counted still, and failed again at the next start.
            try? save(launches, root: root)
            return own
        }
        let folder = root.appendingPathComponent(version, isDirectory: true)
        guard let said = kept(folder, version: version, app: app), judge(said, version, app) == nil
        else { return own }
        launches.tries[version, default: 0] += 1
        do {
            try save(launches, root: root)
        } catch {
            // A start that can't be counted couldn't be gone back on.
            return own
        }
        return Launch(event: event, version: version, folder: folder)
    }

    /// Where to serve `version` from once the page reloads, for a switch
    /// while the app runs: its folder, checked again, or nil for the app's
    /// own screens. The start that follows is counted, as at a launch.
    /// Refused when this build won't run them.
    static func use(root: URL, app: App, version: String) throws -> URL? {
        if version == app.builtIn { return nil }
        guard isVersion(version) else { throw Refused("\(version) is no version of the screens") }
        var launches = readLaunches(root: root, build: app.builtIn)
        if launches.refuses(version) { throw Refused("\(version) didn't start on this phone") }
        let folder = root.appendingPathComponent(version, isDirectory: true)
        guard let said = kept(folder, version: version, app: app) else {
            throw Refused("\(version) isn't kept whole on this phone")
        }
        if judge(said, version, app) != nil { throw Refused("\(version) doesn't run in this app") }
        launches.tries[version, default: 0] += 1
        try save(launches, root: root)
        return folder
    }

    /// Screens that said they started: their starts no longer count against
    /// them, and `event`, when a switch was for one, starts with them from
    /// now on.
    static func started(root: URL, app: App, version: String, event: String?) throws {
        if version != app.builtIn {
            var launches = readLaunches(root: root, build: app.builtIn)
            if launches.tries.removeValue(forKey: version) != nil { try save(launches, root: root) }
        }
        if let event { try RecordsPlugin.keep(version, event: event, slot: eventSlot) }
    }

    /// Screens that didn't say they started in time: this build runs them no more.
    static func failed(root: URL, app: App, version: String) throws {
        var launches = readLaunches(root: root, build: app.builtIn)
        launches.fail(version)
        try save(launches, root: root)
    }

    /// The event the page opens at a start: the one this phone opened last,
    /// by the openedAt the page keeps in each event's record (lastOpened in
    /// web/src/lib/appCopy.ts). Nil when no record says.
    static func lastOpened(records: URL) -> String? {
        guard let events = try? FileManager.default.contentsOfDirectory(atPath: records.path) else {
            return nil
        }
        var last: String?
        var latest = 0.0
        for event in events where RecordsPlugin.isEvent(event) {
            let file = records.appendingPathComponent(event, isDirectory: true)
                .appendingPathComponent(record, isDirectory: false)
            // No record, or none that reads: no event the page opens.
            guard let data = try? readSmall(file, cap: maxRecordBytes),
                  let said = try? object(data, "a record")
            else { continue }
            let opened = number(said["openedAt"])
            if opened > latest {
                latest = opened
                last = event
            }
        }
        return last
    }

    /// The version of the screens `event` last started with, or nil.
    static func remembered(records: URL, event: String) -> String? {
        let file = records.appendingPathComponent(event, isDirectory: true)
            .appendingPathComponent(eventSlot, isDirectory: false)
        guard let kept = try? readSmall(file, cap: 2 * maxVersionLength) else { return nil }
        let version = String(decoding: kept, as: UTF8.self)
        return isVersion(version) ? version : nil
    }

    /// This build's count of starts: nothing counted when the file is
    /// missing, unreadable, or another build's.
    static func readLaunches(root: URL, build: String?) -> Launches {
        var launches = Launches(build: build ?? "")
        guard let data = try? readSmall(root.appendingPathComponent(Screens.launches), cap: maxLaunchesBytes),
              let kept = try? object(data, Screens.launches),
              kept["build"] as? String == launches.build
        else { return launches }
        for (version, count) in kept["tries"] as? [String: Any] ?? [:] where isVersion(version) {
            let times = whole(count)
            if times > 0 { launches.tries[version] = Int(min(times, Double(maxTries))) }
        }
        for version in kept["failed"] as? [Any] ?? [] {
            if let version = version as? String, isVersion(version) { launches.failed.insert(version) }
        }
        return launches
    }

    /// Keep the count of starts, written beside its file and moved over it.
    static func save(_ launches: Launches, root: URL) throws {
        let json: [String: Any] = [
            "build": launches.build,
            "tries": launches.tries,
            "failed": launches.failed.sorted(),
        ]
        var data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        data.append(UInt8(ascii: "\n"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try data.write(to: root.appendingPathComponent(Screens.launches), options: [.atomic])
    }

    private static func marked(_ folder: URL) -> Bool {
        guard let mark = try? readSmall(folder.appendingPathComponent(checked), cap: 128),
              let sums = try? readSmall(folder.appendingPathComponent(Screens.sums), cap: maxSumsBytes)
        else { return false }
        return mark == Data((sha256(sums) + "\n").utf8)
    }

    /// A whole answer from the box, or nil for a 404.
    private static func fetch(_ box: ScreensBox, _ path: String, cap: Int) throws -> Data? {
        var bytes = Data()
        do {
            let found = try box.fetch(path) { chunk in
                if bytes.count + chunk.count > cap { throw Failed("more than a phone takes") }
                bytes.append(chunk)
            }
            return found ? bytes : nil
        } catch {
            throw Failed("\(path): \(describe(error))")
        }
    }

    /// One file of the screens, written to `target` as it comes, and checked.
    private static func fetchInto(
        _ box: ScreensBox, _ path: String, _ target: URL, _ digest: String, cap: Int
    ) throws -> Int {
        let files = FileManager.default
        var hash = SHA256()
        var size = 0
        do {
            guard files.createFile(atPath: target.path, contents: nil) else {
                throw Failed("couldn't be written")
            }
            let handle = try FileHandle(forWritingTo: target)
            defer { try? handle.close() }
            let found = try box.fetch(path) { chunk in
                size += chunk.count
                if size > cap { throw Failed("more than a phone takes") }
                hash.update(data: chunk)
                try handle.write(contentsOf: chunk)
            }
            if !found { throw Failed("not on the box") }
            try handle.synchronize()
        } catch {
            try? files.removeItem(at: target)
            throw Failed("\(path): \(describe(error))")
        }
        if hex(hash.finalize()) != digest {
            try? files.removeItem(at: target)
            throw Failed("\(path) isn't the file that was signed")
        }
        return size
    }

    private static func write(_ file: URL, _ data: Data) throws {
        try data.write(to: file)
    }

    private static func readSmall(_ file: URL, cap: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var data = Data()
        while let chunk = try handle.read(upToCount: 16 * 1024), !chunk.isEmpty {
            data.append(chunk)
            if data.count > cap { throw Failed("\(file.lastPathComponent): more than a phone takes") }
        }
        return data
    }

    private static func isFile(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
            && !directory.boolValue
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
            && directory.boolValue
    }

    private static func size(of file: URL) -> Int {
        (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    }

    /// A JSON object, read as strictly as JSON.parse reads one.
    private static func object(_ json: Data, _ what: String) throws -> [String: Any] {
        // JSONSerialization steps over a byte-order mark, and reads UTF-16
        // and UTF-32 too, which JSON.parse, and so the release, won't. Text
        // in either has a zero byte in it; JSON in UTF-8 never does.
        if json.starts(with: [0xEF, 0xBB, 0xBF]) { throw Refused("\(what) starts with a byte-order mark") }
        if json.contains(0) { throw Refused("\(what) isn't UTF-8") }
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: json, options: [])
        } catch {
            throw Refused("\(what) isn't JSON")
        }
        guard let object = parsed as? [String: Any] else { throw Refused("\(what) isn't a JSON object") }
        return object
    }

    /// A JSON number, or 0 for anything else. JSONSerialization hands back
    /// true and false as numbers.
    private static func number(_ value: Any?) -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return 0
        }
        return number.doubleValue.isFinite ? number.doubleValue : 0
    }

    /// A whole number of 1 or more, as Number.isInteger takes one, or 0 for
    /// anything else. JSONSerialization hands back true and false as numbers.
    private static func whole(_ value: Any?) -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return 0
        }
        let double = number.doubleValue
        return double.isFinite && double == double.rounded(.down) && double >= 1 ? double : 0
    }

    static func sha256(_ data: Data) -> String {
        hex(SHA256.hash(data: data))
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 16 * 1024), !chunk.isEmpty {
            hash.update(data: chunk)
        }
        return hex(hash.finalize())
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// A box, asked for its files over the network. Nothing cached, and no
/// redirects, since a box has no reason to send the phone anywhere else.
/// URLSession takes the compressed copies a box offers and decodes them, and
/// Screens checks what they decode to.
final class BoxOverHttp: ScreensBox {
    private let base: URL

    init(base: URL) {
        self.base = base
    }

    func fetch(_ path: String, into sink: @escaping (Data) throws -> Void) throws -> Bool {
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL else {
            throw Screens.Failed("no address for \(path)")
        }
        let request = Request(sink: sink)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 300
        let session = URLSession(
            configuration: configuration, delegate: request, delegateQueue: request.queue)
        defer { session.finishTasksAndInvalidate() }
        session.dataTask(with: url).resume()
        request.done.wait()
        if let failure = request.failure { throw failure }
        switch request.status {
        case 200: return true
        case 404: return false
        default: throw Screens.Failed("the box answered \(request.status)")
        }
    }

    /// One request's answer, handed to its sink as it comes.
    private final class Request: NSObject, URLSessionDataDelegate {
        let queue: OperationQueue = {
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            return queue
        }()
        let done = DispatchSemaphore(value: 0)
        private let sink: (Data) throws -> Void
        private(set) var status = 0
        private(set) var failure: Error?

        init(sink: @escaping (Data) throws -> Void) {
            self.sink = sink
        }

        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }

        func urlSession(
            _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
            completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
        ) {
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            completionHandler(status == 200 ? .allow : .cancel)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard failure == nil else { return }
            do {
                try sink(data)
            } catch {
                failure = error
                dataTask.cancel()
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            // Any other answer than 200 was cancelled here on purpose, and
            // the caller says what it was.
            if failure == nil, let error = error, status == 200 || status == 0 {
                failure = error
            }
            done.signal()
        }
    }
}

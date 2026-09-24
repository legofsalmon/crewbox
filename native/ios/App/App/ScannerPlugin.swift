import AVFoundation
import Capacitor
import UIKit
import Vision
import VisionKit

/// The join poster's QR, read with the camera, for the join screen
/// (web/src/components/Join.tsx), as `window.Capacitor.Plugins.CrewboxScanner`.
///
/// VisionKit's DataScannerViewController does the reading. It needs iOS 16 and
/// an A12 chip or newer, which is every iPhone that runs iOS 17, this app's
/// minimum. It reads on the phone and sends nothing anywhere. What comes back
/// is the code's text and no more, and the page decides what that is, because
/// a QR is anybody's to print.
///
/// `scan` resolves with what happened, for anything a crew member can do:
/// `scanned` with the text, `cancelled` when they back out, `denied` when the
/// camera is off for Crewbox, and `unavailable` when this iPhone can't scan at
/// all, which includes a camera restricted by Screen Time or a profile: the
/// app's own page in Settings can't change that. It rejects only when the scan
/// can't be shown, which the page words as the camera not starting.
@objc(ScannerPlugin)
public class ScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScannerPlugin"
    public let jsName = "CrewboxScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    /// The scan on screen. The scanner holds its delegate weakly, so this is
    /// what keeps the session alive until it finishes.
    private var session: ScanSession?

    @objc func scan(_ call: CAPPluginCall) {
        Task { @MainActor in self.start(call) }
    }

    /// The app's own page in Settings, where Camera is switched back on.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("This iPhone has no Settings page for the app")
                return
            }
            UIApplication.shared.open(url) { _ in call.resolve() }
        }
    }

    @MainActor private func start(_ call: CAPPluginCall) {
        guard session == nil else {
            call.reject("A scan is already on screen")
            return
        }
        guard DataScannerViewController.isSupported else {
            call.resolve(["result": "unavailable"])
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            show(call)
        case .notDetermined:
            // Asked here rather than left to the scanner, so that the answer
            // comes back to this call whichever way it goes.
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in
                    if granted {
                        self.show(call)
                    } else {
                        call.resolve(["result": "denied"])
                    }
                }
            }
        case .restricted:
            call.resolve(["result": "unavailable"])
        default:
            call.resolve(["result": "denied"])
        }
    }

    @MainActor private func show(_ call: CAPPluginCall) {
        // Available: supported, with the camera allowed and not restricted.
        guard DataScannerViewController.isAvailable else {
            call.resolve(["result": "unavailable"])
            return
        }
        guard let host = bridge?.viewController, host.presentedViewController == nil else {
            call.reject("Something else is on screen")
            return
        }
        let session = ScanSession { [weak self] outcome in
            self?.session = nil
            switch outcome {
            case let .scanned(text):
                call.resolve(["result": "scanned", "text": text])
            case .cancelled:
                call.resolve(["result": "cancelled"])
            case .denied:
                call.resolve(["result": "denied"])
            case .unavailable:
                call.resolve(["result": "unavailable"])
            }
        }
        self.session = session
        // Scanning starts once the screen is up, as Apple's own example does.
        // UIKit calls this back on the main thread, which is where the scan
        // lives, whether or not this SDK's signature says so.
        host.present(session.screen, animated: true) {
            MainActor.assumeIsolated { session.begin() }
        }
    }
}

/// What one scan came to.
private enum ScanOutcome {
    case scanned(String)
    case cancelled
    case denied
    case unavailable
}

/// One scan: the camera, full screen with Cancel, until it reads a QR with
/// text in it or is backed out of.
@MainActor
private final class ScanSession: NSObject, DataScannerViewControllerDelegate {
    let screen: UINavigationController
    private let scanner: DataScannerViewController
    private var done: ((ScanOutcome) -> Void)?
    private var torch: UIBarButtonItem?
    private var torchOn = false

    init(done: @escaping (ScanOutcome) -> Void) {
        // QR only: the poster prints nothing else, and any other kind of code
        // would be something else on the same wall.
        scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        screen = UINavigationController(rootViewController: scanner)
        self.done = done
        super.init()
        scanner.delegate = self
        scanner.title = "Scan the join poster"
        scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel,
            primaryAction: UIAction { [weak self] _ in self?.finish(.cancelled) }
        )
        // A poster in a dark tent needs light on it.
        if AVCaptureDevice.default(for: .video)?.hasTorch == true {
            let torch = UIBarButtonItem(
                image: UIImage(systemName: "flashlight.off.fill"),
                primaryAction: UIAction { [weak self] _ in self?.toggleTorch() }
            )
            torch.accessibilityLabel = "Torch"
            torch.accessibilityValue = "Off"
            scanner.navigationItem.rightBarButtonItem = torch
            self.torch = torch
        }
        // A bar with its own background: Cancel has to read over whatever the
        // camera is pointed at, in daylight.
        let bar = UINavigationBarAppearance()
        bar.configureWithDefaultBackground()
        screen.navigationBar.standardAppearance = bar
        screen.navigationBar.scrollEdgeAppearance = bar
        // Full screen: a sheet can be swiped away past Cancel, and then the
        // page would never hear how the scan ended.
        screen.modalPresentationStyle = .fullScreen
    }

    func begin() {
        do {
            try scanner.startScanning()
        } catch let error as DataScannerViewController.ScanningUnavailable {
            finish(Self.outcome(of: error))
        } catch {
            finish(.unavailable)
        }
    }

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        didAdd addedItems: [RecognizedItem],
        allItems: [RecognizedItem]
    ) {
        for item in addedItems {
            // A QR can carry bytes that aren't text, which no poster prints:
            // the camera stays up for the one that is.
            if case let .barcode(code) = item, let text = code.payloadStringValue, !text.isEmpty {
                finish(.scanned(text))
                return
            }
        }
    }

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
    ) {
        finish(Self.outcome(of: error))
    }

    /// Restricted is Apple's word for the camera not being allowed, whether
    /// by the crew member or by a profile.
    private static func outcome(of error: DataScannerViewController.ScanningUnavailable)
        -> ScanOutcome
    {
        if case .cameraRestricted = error { return .denied }
        return .unavailable
    }

    private func toggleTorch() {
        setTorch(!torchOn)
    }

    private func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch,
            device.isTorchAvailable, (try? device.lockForConfiguration()) != nil
        else { return }
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
        torchOn = on
        torch?.image = UIImage(systemName: on ? "flashlight.on.fill" : "flashlight.off.fill")
        torch?.accessibilityValue = on ? "On" : "Off"
    }

    private func finish(_ outcome: ScanOutcome) {
        guard let done else { return }
        self.done = nil
        if torchOn { setTorch(false) }
        scanner.stopScanning()
        if case .scanned = outcome {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
        screen.presentingViewController?.dismiss(animated: true)
        done(outcome)
    }
}

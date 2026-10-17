import AppKit
import ApplicationServices
import CryptoKit
import MessageGuardCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var allowed: Set<String>
    private let backend: BackendClient
    private let preview: Bool
    private let requestStartOnLaunch: Bool
    private let diagnostics: Bool
    private var reader: FocusedInputReader
    private let popup = ReminderPanel()
    private var monitor: KeyboardMonitor?
    private var statusItem: NSStatusItem!
    private var startItem: NSMenuItem!
    private var pauseItem: NSMenuItem!
    private var statusLabel: NSMenuItem!
    private var allowedLabel: NSMenuItem!
    private var gate = ReviewGate()
    private var recent = RecentReviews()
    private var matcher: KeywordMatcher?
    private var reviewTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var nextRequestAt = Date.distantPast
    private var observer: NSObjectProtocol?

    init(allowed: Set<String>, backend: BackendClient, preview: Bool = false,
         requestStartOnLaunch: Bool = false, diagnostics: Bool = false) {
        self.allowed = allowed
        self.backend = backend
        self.preview = preview
        self.requestStartOnLaunch = requestStartOnLaunch
        self.diagnostics = diagnostics
        self.reader = FocusedInputReader(allowedApplications: allowed)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "shield", accessibilityDescription: "AI Firewall")
        let menu = NSMenu()
        statusLabel = NSMenuItem(title: "Paused", action: nil, keyEquivalent: "")
        menu.addItem(statusLabel)
        menu.addItem(.separator())
        startItem = NSMenuItem(title: "Start protection…", action: #selector(start), keyEquivalent: "")
        startItem.target = self
        menu.addItem(startItem)
        pauseItem = NSMenuItem(title: "Pause protection", action: #selector(pause), keyEquivalent: "")
        pauseItem.target = self
        menu.addItem(pauseItem)
        menu.addItem(.separator())
        let configure = NSMenuItem(title: "Configure allowed apps…", action: #selector(configureApps), keyEquivalent: "")
        configure.target = self
        menu.addItem(configure)
        allowedLabel = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        menu.addItem(allowedLabel)
        let quit = NSMenuItem(title: "Quit AI Firewall", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(.separator())
        menu.addItem(quit)
        menu.autoenablesItems = false
        statusItem.menu = menu
        popup.onPause = { [weak self] in self?.pause() }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.gate.enabled else { return }
                self.invalidate()
            }
        }
        updateStatus(allowed.isEmpty ? "Paused · configure allowed apps first" : "Paused · choose Start protection to enable")
        if preview {
            popup.show(MessageAssessment(
                status: "assessed", shouldRemind: true,
                reason: "Sample reminder: a personal insult may escalate the conversation.",
                matchedTerms: ["idiot"],
                suggestedRevision: "I disagree with this approach. Please check the report again."
            ))
            updateStatus("Preview · protection is paused; no input is being monitored")
        } else if requestStartOnLaunch {
            DispatchQueue.main.async { [weak self] in self?.start() }
        }
    }

    @objc private func start() {
        guard !allowed.isEmpty, !gate.enabled, startupTask == nil else { return }
        let consent = NSAlert()
        consent.messageText = "Enable message reminders?"
        consent.informativeText = "Only editable fields in these apps will be checked: "
            + allowed.sorted().joined(separator: ", ")
            + ". Keyboard characters are not recorded. When a sensitive term matches, up to "
            + "4,000 UTF-16 units around the cursor are sent to your backend and its AI provider. "
            + "Standard secure text fields are skipped. You can pause from this menu at any time."
        consent.addButton(withTitle: "Enable")
        consent.addButton(withTitle: "Cancel")
        guard consent.runModal() == .alertFirstButtonReturn else { return }
        guard AXIsProcessTrusted() else {
            permissionHelp(name: "Accessibility", anchor: "Privacy_Accessibility")
            return
        }
        guard CGPreflightListenEventAccess() else {
            CGRequestListenEventAccess()
            permissionHelp(name: "Input Monitoring", anchor: "Privacy_ListenEvent")
            return
        }
        updateStatus("Connecting to backend…")
        startItem.isEnabled = false
        startupTask = Task { [weak self] in
            guard let self else { return }
            defer {
                startupTask = nil
                startItem.isEnabled = !gate.enabled && !allowed.isEmpty
                pauseItem.isEnabled = gate.enabled
            }
            do {
                matcher = try KeywordMatcher(terms: await backend.terms())
                trace("keyword_configuration_loaded")
                try Task.checkCancellation()
                monitor = KeyboardMonitor { [weak self] in
                    Task { @MainActor in self?.inputChanged() }
                }
                guard monitor?.start() == true else {
                    trace("event_tap_start_failed")
                    updateStatus("Paused · keyboard monitoring could not start")
                    return
                }
                gate.start()
                trace("monitoring_started")
                updateStatus("Protection on")
            } catch is CancellationError {
                return
            } catch {
                trace("startup_failed")
                updateStatus("Paused · backend unavailable; check server and token")
            }
        }
        pauseItem.isEnabled = true
    }

    @objc private func pause() {
        trace("paused")
        gate.pause()
        startupTask?.cancel()
        monitor?.stop()
        monitor = nil
        reviewTask?.cancel()
        reviewTask = nil
        popup.close()
        recent.clear()
        matcher = nil
        updateStatus("Paused")
    }

    private func invalidate() {
        gate.changed()
        reviewTask?.cancel()
        reviewTask = nil
        popup.close()
    }

    private func inputChanged() {
        guard gate.enabled else { return }
        invalidate()
        let revision = gate.revision
        reviewTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: 600_000_000)
                let wait = nextRequestAt.timeIntervalSinceNow
                if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
                try Task.checkCancellation()
                guard gate.enabled, gate.revision == revision else { return }
                guard AXIsProcessTrusted() else { pause(); return }
                guard let input = reader.read() else {
                    trace("capture_skipped:" + reader.lastSkipReason)
                    return
                }
                guard let matcher, !matcher.matches(in: input.snapshot.content).isEmpty else {
                    trace("no_keyword_match")
                    return
                }
                let digest = SHA256.hash(data: Data((input.snapshot.applicationID + "\0"
                    + input.snapshot.fieldID + "\0" + input.snapshot.content).utf8))
                    .map { String(format: "%02x", $0) }.joined()
                guard !recent.contains(digest) else { trace("duplicate_suppressed"); return }
                nextRequestAt = Date().addingTimeInterval(3)
                trace("assessment_requested")
                let result = try await backend.assess(input.snapshot)
                trace(result.should_remind ? "reminder_received" : "no_reminder_received")
                try Task.checkCancellation()
                guard let current = reader.read(), CFEqual(current.element, input.element),
                      gate.accepts(revision: revision, captured: input.snapshot, current: current.snapshot)
                else { trace("stale_result_discarded"); return }
                recent.insert(digest)
                updateStatus("Protection on")
                if result.should_remind { popup.show(result); trace("reminder_displayed") }
            } catch is CancellationError {
                return
            } catch {
                guard gate.enabled, gate.revision == revision, !Task.isCancelled else { return }
                nextRequestAt = Date().addingTimeInterval(15)
                trace("assessment_failed")
                updateStatus("Protection on · review unavailable; check before sending")
            }
        }
    }

    private func trace(_ stage: String) {
        guard diagnostics else { return }
        print("MessageGuard: " + stage)
        fflush(stdout)
    }

    private func updateStatus(_ text: String) {
        statusLabel.title = text
        statusItem.button?.title = gate.enabled ? (text.contains("unavailable") ? " Check" : " On") : " Paused"
        statusItem.button?.toolTip = text
        startItem.isEnabled = !allowed.isEmpty && !gate.enabled && startupTask == nil
        pauseItem.isEnabled = gate.enabled || startupTask != nil
        allowedLabel.title = allowed.isEmpty ? "No applications allowed" : "Allowed: " + allowed.sorted().joined(separator: ", ")
    }

    @objc private func configureApps() {
        pause()
        let alert = NSAlert()
        alert.messageText = "Allowed applications"
        alert.informativeText = "Enter application bundle IDs separated by commas. For example: "
            + "com.apple.TextEdit, com.tinyspeck.slackmacgap. Changes apply to this session only. "
            + "Protection stays paused until you choose Start protection."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
        field.stringValue = allowed.sorted().joined(separator: ", ")
        field.placeholderString = "com.apple.TextEdit"
        alert.accessoryView = field
        alert.addButton(withTitle: "Apply")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let values = field.stringValue.components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard values.allSatisfy({ $0.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z0-9.-]+$", options: .regularExpression) != nil }) else {
            updateStatus("Paused · invalid application bundle ID; configure apps again")
            return
        }
        allowed = Set(values)
        reader = FocusedInputReader(allowedApplications: allowed)
        updateStatus(allowed.isEmpty ? "Paused · no applications allowed" : "Paused · application list updated")
    }

    private func permissionHelp(name: String, anchor: String) {
        let alert = NSAlert()
        alert.messageText = name + " permission is required"
        alert.informativeText = "Enable AI Firewall (or the terminal launching the executable) "
            + "in System Settings → Privacy & Security → " + name
            + ". Restart the app if macOS requests it, then choose Start protection again."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + anchor) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quit() { pause(); NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        pause()
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }
}

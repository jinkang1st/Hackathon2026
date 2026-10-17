import AppKit
import MessageGuardCore

final class ReminderPanel: NSObject {
    private var panel: NSPanel?
    private var suggestion: String?
    var onPause: (() -> Void)?

    func show(_ assessment: MessageAssessment) {
        close()
        suggestion = assessment.suggested_revision
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 280),
            styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false
        )
        panel.title = "AI Firewall · Message reminder"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let heading = NSTextField(labelWithString: "Take a moment before sending")
        heading.font = .boldSystemFont(ofSize: 17)
        let reason = NSTextField(wrappingLabelWithString: assessment.reason)
        reason.maximumNumberOfLines = 6
        let stack = NSStackView(views: [heading, reason])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        if let suggestion, !suggestion.isEmpty {
            let label = NSTextField(wrappingLabelWithString: "Suggested wording: " + suggestion)
            label.textColor = .secondaryLabelColor
            label.maximumNumberOfLines = 5
            stack.addArrangedSubview(label)
        }
        let buttons = NSStackView()
        buttons.spacing = 8
        buttons.addArrangedSubview(NSButton(title: "Keep editing", target: self, action: #selector(dismiss)))
        if suggestion != nil {
            buttons.addArrangedSubview(NSButton(title: "Copy suggestion", target: self, action: #selector(copySuggestion)))
        }
        buttons.addArrangedSubview(NSButton(title: "Pause protection", target: self, action: #selector(pause)))
        stack.addArrangedSubview(buttons)
        let note = NSTextField(wrappingLabelWithString: "Your message has not been changed or sent.")
        note.font = .systemFont(ofSize: 11)
        note.textColor = .secondaryLabelColor
        stack.addArrangedSubview(note)
        guard let view = panel.contentView else { return }
        view.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -20)
        ])
        let size = stack.fittingSize
        panel.setContentSize(NSSize(width: 440, height: max(220, size.height + 40)))
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1000, height: 800)
        panel.setFrameTopLeftPoint(NSPoint(x: screen.maxX - 460, y: screen.maxY - 20))
        self.panel = panel
        panel.orderFrontRegardless()
    }

    func close() { panel?.close(); panel = nil; suggestion = nil }
    @objc private func dismiss() { close() }
    @objc private func pause() { close(); onPause?() }
    @objc private func copySuggestion() {
        guard let suggestion else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(suggestion, forType: .string)
        close()
    }
}

import AppKit
import ApplicationServices
import MessageGuardCore

struct FocusedInput {
    let snapshot: DraftSnapshot
    let element: AXUIElement
}

final class FocusedInputReader {
    let allowedApplications: Set<String>
    private(set) var lastSkipReason = "none"

    init(allowedApplications: Set<String>) { self.allowedApplications = allowedApplications }

    func read() -> FocusedInput? {
        lastSkipReason = "accessibility_not_granted"
        guard AXIsProcessTrusted() else { return nil }
        lastSkipReason = "foreground_application_unavailable"
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleID = app.bundleIdentifier else { return nil }
        lastSkipReason = "application_not_allowed"
        guard allowedApplications.contains(bundleID) else { return nil }

        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.2)
        lastSkipReason = "focused_control_unavailable"
        guard let rawElement = attribute(application, kAXFocusedUIElementAttribute),
              CFGetTypeID(rawElement) == AXUIElementGetTypeID() else { return nil }
        let element = rawElement as! AXUIElement
        var editable = DarwinBoolean(false)
        lastSkipReason = "editable_flag_unavailable"
        guard AXUIElementIsAttributeSettable(
            element, kAXValueAttribute as CFString, &editable
        ) == .success else { return nil }
        let policy = CapturePolicy(allowedApplications: allowedApplications)
        lastSkipReason = "unsupported_readonly_or_secure_control"
        guard policy.allows(
            applicationID: bundleID, role: attribute(element, kAXRoleAttribute) as? String,
            subrole: attribute(element, kAXSubroleAttribute) as? String,
            editable: editable.boolValue
        ) else {
            return nil
        }
        // Require a valid caret/selection. Unsupported or inaccessible fields are skipped.
        lastSkipReason = "selection_unavailable"
        guard let selectionValue = attribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(selectionValue) == AXValueGetTypeID() else { return nil }
        var selection = CFRange(location: 0, length: 0)
        lastSkipReason = "invalid_selection"
        guard AXValueGetValue(selectionValue as! AXValue, .cfRange, &selection),
              selection.location >= 0 else { return nil }

        let start = max(0, selection.location - 2000)
        var content: String?
        lastSkipReason = "context_unavailable_or_empty"
        if let count = attribute(element, kAXNumberOfCharactersAttribute) as? NSNumber {
            let length = max(0, min(4000, count.intValue - start))
            var range = CFRange(location: start, length: length)
            if let rangeValue = AXValueCreate(.cfRange, &range) {
                var value: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(
                    element, kAXStringForRangeParameterizedAttribute as CFString, rangeValue, &value
                ) == .success {
                    content = value as? String
                }
            }
        }
        if content == nil, let value = attribute(element, kAXValueAttribute) as? String {
            let text = value as NSString
            // A fallback for standard editable controls; do not process very large documents.
            guard text.length <= 200_000, start <= text.length else { return nil }
            content = text.substring(with: NSRange(location: start, length: min(4000, text.length - start)))
        }
        guard let content, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let snapshot = DraftSnapshot(
            applicationID: bundleID,
            fieldID: "\(app.processIdentifier):\(CFHash(element)):\(start)",
            content: content
        )
        lastSkipReason = "none"
        return FocusedInput(snapshot: snapshot, element: element)
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
            return nil
        }
        return value
    }
}

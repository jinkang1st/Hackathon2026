import Foundation

public struct CapturePolicy {
    public let allowedApplications: Set<String>

    public init(allowedApplications: Set<String>) {
        self.allowedApplications = allowedApplications
    }

    public func allows(applicationID: String, role: String?, subrole: String?, editable: Bool) -> Bool {
        allowedApplications.contains(applicationID)
            && editable
            && ["AXTextField", "AXTextArea", "AXComboBox"].contains(role ?? "")
            && subrole != "AXSecureTextField"
    }
}

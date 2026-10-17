import Foundation

public struct SensitiveTerm: Codable {
    public enum MatchMode: String, Codable { case word, substring }
    public let term: String
    public let match_mode: MatchMode

    public init(term: String, matchMode: MatchMode) {
        self.term = term
        self.match_mode = matchMode
    }
}

public struct TermsResponse: Decodable { public let terms: [SensitiveTerm] }

public struct MessageRequest: Encodable {
    public let enabled = true
    public let content: String
    public let application: String

    public init(content: String, application: String) {
        self.content = content
        self.application = application
    }
}

public struct MessageAssessment: Decodable {
    public let status: String
    public let should_remind: Bool
    public let reason: String
    public let matched_terms: [String]
    public let suggested_revision: String?

    public init(status: String, shouldRemind: Bool, reason: String,
                matchedTerms: [String], suggestedRevision: String?) {
        self.status = status
        self.should_remind = shouldRemind
        self.reason = reason
        self.matched_terms = matchedTerms
        self.suggested_revision = suggestedRevision
    }
}

public struct DraftSnapshot: Equatable {
    public let applicationID: String
    public let fieldID: String
    public let content: String

    public init(applicationID: String, fieldID: String, content: String) {
        self.applicationID = applicationID
        self.fieldID = fieldID
        self.content = content
    }
}

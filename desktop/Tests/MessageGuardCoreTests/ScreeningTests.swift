import XCTest
@testable import MessageGuardCore

final class ScreeningTests: XCTestCase {
    func testCapturePolicyExcludesOtherAppsPasswordsAndUnknownControls() {
        let policy = CapturePolicy(allowedApplications: ["allowed"])
        XCTAssertTrue(policy.allows(applicationID: "allowed", role: "AXTextArea", subrole: nil, editable: true))
        XCTAssertFalse(policy.allows(applicationID: "other", role: "AXTextArea", subrole: nil, editable: true))
        XCTAssertFalse(policy.allows(applicationID: "allowed", role: "AXTextField", subrole: "AXSecureTextField", editable: true))
        XCTAssertFalse(policy.allows(applicationID: "allowed", role: "AXButton", subrole: nil, editable: true))
        XCTAssertFalse(policy.allows(applicationID: "allowed", role: nil, subrole: nil, editable: true))
        XCTAssertFalse(policy.allows(applicationID: "allowed", role: "AXTextArea", subrole: nil, editable: false))
    }

    func testKeywordNormalizationAndBoundaries() throws {
        let matcher = try KeywordMatcher(terms: [
            SensitiveTerm(term: "stupid", matchMode: .word),
            SensitiveTerm(term: "shit", matchMode: .word),
            SensitiveTerm(term: "蠢货", matchMode: .substring)
        ])
        XCTAssertEqual(matcher.matches(in: "You are STUPID!"), ["stupid"])
        XCTAssertEqual(matcher.matches(in: "You are ｓｔｕｐｉｄ"), ["stupid"])
        XCTAssertEqual(matcher.matches(in: "stupidity and shiitake"), [])
        XCTAssertEqual(matcher.matches(in: "你这个蠢货"), ["蠢货"])
        XCTAssertEqual(matcher.matches(in: "a polite message"), [])
    }

    func testMetacharactersAreLiteralAndNotExecutableRegex() throws {
        let matcher = try KeywordMatcher(terms: [SensitiveTerm(term: ".*", matchMode: .substring)])
        XCTAssertEqual(matcher.matches(in: "Hello"), [])
        XCTAssertEqual(matcher.matches(in: "Use .* literally"), [".*"])
    }

    func testPausedOrChangedDraftCannotShowAnOldResult() {
        let draft = DraftSnapshot(applicationID: "com.apple.TextEdit", fieldID: "1", content: "draft")
        var gate = ReviewGate()
        XCTAssertFalse(gate.accepts(revision: gate.revision, captured: draft, current: draft))
        gate.start()
        let revision = gate.revision
        XCTAssertTrue(gate.accepts(revision: revision, captured: draft, current: draft))
        gate.changed()
        XCTAssertFalse(gate.accepts(revision: revision, captured: draft, current: draft))
        gate.pause()
        XCTAssertFalse(gate.accepts(revision: gate.revision, captured: draft, current: draft))
    }

    func testFocusAndTextChangesInvalidateAResultEvenWithoutAKeyboardEvent() {
        let draft = DraftSnapshot(applicationID: "allowed", fieldID: "1", content: "draft")
        var gate = ReviewGate()
        gate.start()
        let others = [
            DraftSnapshot(applicationID: "other", fieldID: "1", content: "draft"),
            DraftSnapshot(applicationID: "allowed", fieldID: "2", content: "draft"),
            DraftSnapshot(applicationID: "allowed", fieldID: "1", content: "edited")
        ]
        for other in others {
            XCTAssertFalse(gate.accepts(revision: gate.revision, captured: draft, current: other))
        }
        XCTAssertFalse(gate.accepts(revision: gate.revision, captured: draft, current: nil))
    }

    func testIdenticalDraftsAreDeduplicatedOnlyForTheConfiguredTime() {
        var recent = RecentReviews(ttl: 120, limit: 2)
        let now = Date(timeIntervalSince1970: 1000)
        recent.insert("hashed-draft", now: now)
        XCTAssertTrue(recent.contains("hashed-draft", now: now.addingTimeInterval(119)))
        XCTAssertFalse(recent.contains("hashed-draft", now: now.addingTimeInterval(120)))
    }

    func testDeduplicationHasABoundAndClearsOnPause() {
        var recent = RecentReviews(ttl: 120, limit: 2)
        let now = Date(timeIntervalSince1970: 1000)
        recent.insert("one", now: now)
        recent.insert("two", now: now.addingTimeInterval(1))
        recent.insert("three", now: now.addingTimeInterval(2))
        XCTAssertFalse(recent.contains("one", now: now.addingTimeInterval(3)))
        XCTAssertTrue(recent.contains("three", now: now.addingTimeInterval(3)))
        recent.clear()
        XCTAssertFalse(recent.contains("three", now: now.addingTimeInterval(3)))
    }

    func testBackendRejectsInsecureRemoteURLsAndEmbeddedCredentials() {
        for value in ["http://example.com", "https://user:secret@example.com", "https://example.com?key=secret"] {
            XCTAssertThrowsError(try BackendClient(baseURL: URL(string: value)!))
        }
        XCTAssertNoThrow(try BackendClient(baseURL: URL(string: "http://127.0.0.1:8000")!))
        XCTAssertNoThrow(try BackendClient(baseURL: URL(string: "https://example.com")!))
    }

    func testRequestUsesExplicitOptInAndPreservesUnicode() throws {
        let data = try JSONEncoder().encode(MessageRequest(content: "原始草稿", application: "allowed"))
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(value["enabled"] as? Bool, true)
        XCTAssertEqual(value["content"] as? String, "原始草稿")
        XCTAssertEqual(value["application"] as? String, "allowed")
    }
}

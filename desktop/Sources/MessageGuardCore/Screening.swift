import Foundation

public struct KeywordMatcher {
    private let patterns: [(SensitiveTerm, NSRegularExpression)]

    public init(terms: [SensitiveTerm]) throws {
        self.patterns = try terms.map { item in
            let term = item.term.precomposedStringWithCompatibilityMapping.lowercased()
            var pattern = NSRegularExpression.escapedPattern(for: term)
            if item.match_mode == .word {
                pattern = "(?<![\\p{L}\\p{N}_])" + pattern + "(?![\\p{L}\\p{N}_])"
            }
            return (item, try NSRegularExpression(pattern: pattern))
        }
    }

    public func matches(in content: String) -> [String] {
        let text = content.precomposedStringWithCompatibilityMapping.lowercased()
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return patterns.compactMap { item, pattern in
            pattern.firstMatch(in: text, range: range) == nil ? nil : item.term
        }
    }
}

public struct ReviewGate {
    public private(set) var enabled = false
    public private(set) var revision = 0

    public init() {}
    public mutating func start() { enabled = true; revision += 1 }
    public mutating func pause() { enabled = false; revision += 1 }
    public mutating func changed() { revision += 1 }

    public func accepts(revision: Int, captured: DraftSnapshot, current: DraftSnapshot?) -> Bool {
        enabled && self.revision == revision && current == captured
    }
}

public struct RecentReviews {
    private var entries: [String: Date] = [:]
    private let ttl: TimeInterval
    private let limit: Int

    public init(ttl: TimeInterval = 120, limit: Int = 128) {
        self.ttl = ttl
        self.limit = max(1, limit)
    }

    public mutating func contains(_ digest: String, now: Date = Date()) -> Bool {
        entries = entries.filter { now.timeIntervalSince($0.value) < ttl }
        return entries[digest] != nil
    }

    public mutating func insert(_ digest: String, now: Date = Date()) {
        if entries.count >= limit, let oldest = entries.min(by: { $0.value < $1.value })?.key {
            entries.removeValue(forKey: oldest)
        }
        entries[digest] = now
    }

    public mutating func clear() { entries.removeAll() }
}

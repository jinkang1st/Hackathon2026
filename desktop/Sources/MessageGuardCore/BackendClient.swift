import Foundation

public enum BackendError: LocalizedError {
    case invalidURL, requestFailed(Int), invalidResponse

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Use HTTPS or an HTTP loopback address for the backend."
        case .requestFailed(let status): return "The backend returned HTTP \(status). Check its configuration."
        case .invalidResponse: return "The backend returned an invalid message assessment."
        }
    }
}

private final class RedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Do not forward draft text or the backend token to a redirected endpoint.
        completionHandler(nil)
    }
}

public final class BackendClient {
    private let baseURL: URL
    private let token: String?
    private let session: URLSession

    public init(baseURL: URL, token: String? = nil) throws {
        let local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(baseURL.host ?? "")
        guard let host = baseURL.host, !host.isEmpty,
              baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil,
              baseURL.scheme == "https" || (baseURL.scheme == "http" && local) else {
            throw BackendError.invalidURL
        }
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 35
        config.timeoutIntervalForResource = 40
        self.session = URLSession(configuration: config, delegate: RedirectPolicy(), delegateQueue: nil)
    }

    public func terms() async throws -> [SensitiveTerm] {
        let data = try await send(path: "api/v1/messages/terms")
        let result = try JSONDecoder().decode(TermsResponse.self, from: data)
        guard !result.terms.isEmpty, result.terms.count <= 256,
              result.terms.allSatisfy({ !$0.term.isEmpty && $0.term.count <= 64 }) else {
            throw BackendError.invalidResponse
        }
        return result.terms
    }

    public func assess(_ snapshot: DraftSnapshot) async throws -> MessageAssessment {
        let body = try JSONEncoder().encode(MessageRequest(
            content: snapshot.content, application: snapshot.applicationID
        ))
        let data = try await send(path: "api/v1/messages/assess", body: body)
        let result = try JSONDecoder().decode(MessageAssessment.self, from: data)
        guard result.status == "assessed", !result.matched_terms.isEmpty,
              !result.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BackendError.invalidResponse
        }
        return result
    }

    private func send(path: String, body: Data? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token, !token.isEmpty {
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        guard response.statusCode == 200 else { throw BackendError.requestFailed(response.statusCode) }
        return data
    }
}

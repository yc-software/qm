import Foundation

final class SameOriginRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

@MainActor
@Observable final class APIClient {
  let baseURL: URL
  let vault: SessionVault
  private let session: URLSession
  private let redirects = SameOriginRedirects()
  private var token: String?
  private(set) var generation = UUID()

  init(baseURL: URL, configuration: URLSessionConfiguration = .ephemeral) {
    self.baseURL = baseURL
    vault = SessionVault(account: baseURL.absoluteString)
    token = vault.read()
    let config = configuration
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 45
    session = URLSession(configuration: config)
  }

  var hasSession: Bool { token != nil }

  func saveSession(_ value: String) throws {
    try vault.write(value)
    token = value
  }

  func signOut() {
    generation = UUID()
    token = nil
    vault.delete()
  }

  func url(_ path: String, query: [URLQueryItem] = []) -> URL {
    var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/%?#"))
    parts.percentEncodedPath =
      "/"
      + path.split(separator: "/", omittingEmptySubsequences: false).map {
        let component = String($0)
        return (component.removingPercentEncoding ?? component).addingPercentEncoding(
          withAllowedCharacters: allowed)!
      }.joined(separator: "/")
    if !query.isEmpty { parts.queryItems = query }
    return parts.url!
  }

  func request(
    _ path: String, body: [String: Any]? = nil, query: [URLQueryItem] = [], method: String? = nil
  ) throws
    -> URLRequest
  {
    var request = URLRequest(url: url(path, query: query))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("ios", forHTTPHeaderField: "X-QM-Client")
    request.setValue(
      baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
      forHTTPHeaderField: "Origin")
    if let token { request.setValue("portal_session=\(token)", forHTTPHeaderField: "Cookie") }
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    if let method { request.httpMethod = method }
    return request
  }

  func fetch<T: Decodable>(
    _ path: String, body: [String: Any]? = nil, query: [URLQueryItem] = [], method: String? = nil,
    accepting statusCodes: Set<Int> = [], timeout: TimeInterval? = nil
  )
    async throws -> T
  {
    let current = generation
    var request = try request(path, body: body, query: query, method: method)
    if let timeout { request.timeoutInterval = timeout }
    let (data, response) = try await session.data(for: request, delegate: redirects)
    try check(response, generation: current, accepting: statusCodes, data: data)
    return try Self.decode(T.self, from: data, path: path)
  }

  nonisolated static func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String)
    throws -> T
  {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch let error as DecodingError {
      Log.decoding.error(
        "Decoding \(String(describing: T.self), privacy: .public) from \(path, privacy: .public) failed: \(error.summary, privacy: .public) \(String(describing: error), privacy: .public)"
      )
      throw QMError.message("QM sent a reply this app could not read (\(error.summary)).")
    }
  }

  func transcribe(file: URL) async throws -> String {
    let current = generation
    var request = try request("api/dictation", method: "POST")
    request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 75
    let (data, response) = try await session.upload(
      for: request, fromFile: file, delegate: redirects)
    try check(response, generation: current, data: data)
    struct Transcript: Decodable { let text: String }
    return try JSONDecoder().decode(Transcript.self, from: data).text
  }

  func redeemSignIn(code: String, verifier: String, state: String) async throws -> String {
    let current = generation
    var request = try request("auth/desktop/redeem", method: "POST")
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue(nil, forHTTPHeaderField: "Cookie")
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    request.httpBody = Data(
      [("code", code), ("verifier", verifier), ("state", state)].map { name, value in
        "\(name)=\(value.addingPercentEncoding(withAllowedCharacters: allowed)!)"
      }.joined(separator: "&").utf8)
    let (data, response) = try await session.data(for: request, delegate: redirects)
    try check(response, generation: current, data: data, persistSession: false)
    struct Exchange: Decodable { let ok: Bool }
    guard try JSONDecoder().decode(Exchange.self, from: data).ok,
      let response = response as? HTTPURLResponse,
      let session = sessionCookie(response)
    else { throw QMError.message("QM did not return a sign-in session. Please try again.") }
    return session
  }

  func storeFile(_ attachment: PreparedAttachment, scope: String?) async throws {
    defer { withExtendedLifetime(attachment) {} }
    let current = generation
    var query = [
      URLQueryItem(name: "sha", value: attachment.sha),
      URLQueryItem(name: "name", value: attachment.name),
    ]
    if let scope { query.append(.init(name: "scope", value: scope)) }
    var request = try request("api/files/upload", query: query, method: "POST")
    request.setValue(attachment.mimetype, forHTTPHeaderField: "Content-Type")
    let (data, response) = try await session.upload(
      for: request, fromFile: attachment.url, delegate: redirects)
    try check(response, generation: current, data: data)
  }

  func upload(_ attachment: PreparedAttachment) async throws -> UploadedBlob {
    defer { withExtendedLifetime(attachment) {} }
    let current = generation
    var request = try request(
      "api/blobs", query: [.init(name: "sha", value: attachment.sha)], method: "POST")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let (responseData, response) = try await session.upload(
      for: request, fromFile: attachment.url, delegate: redirects)
    try check(response, generation: current, data: responseData)
    return try JSONDecoder().decode(UploadedBlob.self, from: responseData)
  }

  func download(_ path: String) async throws -> URL {
    let current = generation
    var request = try request(path)
    request.setValue("*/*", forHTTPHeaderField: "Accept")
    let (file, response) = try await session.download(for: request, delegate: redirects)
    do {
      try check(response, generation: current)
      return file
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw error
    }
  }

  func imageData(_ path: String, query: [URLQueryItem] = [], maximumBytes: Int = 8 * 1024 * 1024)
    async throws -> Data
  {
    let current = generation
    var request = try request(path, query: query)
    request.setValue("image/*", forHTTPHeaderField: "Accept")
    let (bytes, response) = try await session.bytes(for: request, delegate: redirects)
    defer { bytes.task.cancel() }
    try check(response, generation: current)
    guard response.expectedContentLength <= maximumBytes else {
      throw QMError.message("This image is too large for an inline preview.")
    }
    var data = Data()
    for try await byte in bytes {
      guard data.count < maximumBytes else {
        throw QMError.message("This image is too large for an inline preview.")
      }
      data.append(byte)
    }
    try check(response, generation: current)
    return data
  }

  nonisolated static func sameOrigin(_ url: URL, _ base: URL) -> Bool {
    url.scheme == base.scheme && url.host == base.host
      && (url.port ?? (url.scheme == "https" ? 443 : 80))
        == (base.port ?? (base.scheme == "https" ? 443 : 80))
  }

  func stream(_ runID: String, onEvent: (StreamEvent) throws -> Void) async throws {
    let current = generation
    var request = try request("api/runs/\(runID)/events")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let (bytes, response) = try await session.bytes(for: request, delegate: redirects)
    defer { bytes.task.cancel() }
    try check(response, generation: current)
    try await Self.readEvents(bytes) { data in
      guard current == self.generation else { throw CancellationError() }
      let event = try Self.decode(StreamEvent.self, from: data, path: "api/runs/\(runID)/events")
      try onEvent(event)
      return event.type == "RUN_FINISHED" || event.run?.isFinished == true
    }
  }

  nonisolated private static func readEvents(
    _ bytes: URLSession.AsyncBytes, onData: @MainActor (Data) throws -> Bool
  ) async throws {
    var decoder = EventStreamDecoder()
    for try await byte in bytes {
      guard let data = decoder.push(byte) else { continue }
      try Task.checkCancellation()
      if try await onData(data) { return }
    }
  }

  nonisolated static func errorMessage(status: Int, data: Data?) -> String {
    if let data, data.count <= 65536,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let message = object["message"] as? String,
      !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      return message
    }
    switch status {
    case 403: return "You don’t have access to this action or feature."
    case 404: return "This item or feature is not available on this workspace."
    case 409:
      return "This changed elsewhere. Refresh before trying again."
    case 413: return "This file or request is too large."
    case 429: return "QM is receiving too many requests. Wait a moment and try again."
    default: return "QM could not complete this request (HTTP \(status)). Please try again."
    }
  }

  private func check(
    _ response: URLResponse, generation current: UUID, accepting statusCodes: Set<Int> = [],
    data: Data? = nil, persistSession: Bool = true
  ) throws {
    try Task.checkCancellation()
    guard current == generation else { throw CancellationError() }
    guard let response = response as? HTTPURLResponse else {
      throw QMError.message("Invalid server response.")
    }
    if response.statusCode == 401 {
      if persistSession { signOut() }
      throw QMError.signedOut
    }
    guard (200..<300).contains(response.statusCode) || statusCodes.contains(response.statusCode)
    else {
      let detail = Self.errorMessage(status: response.statusCode, data: data)
      if [400, 403, 404, 413, 415, 422].contains(response.statusCode) {
        throw QMError.rejected(detail)
      }
      throw QMError.message(detail)
    }
    if persistSession, let session = sessionCookie(response) {
      try saveSession(session)
    }
  }

  private func sessionCookie(_ response: HTTPURLResponse) -> String? {
    let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
      if let name = item.key as? String, let value = item.value as? String { result[name] = value }
    }
    return HTTPCookie.cookies(withResponseHeaderFields: headers, for: baseURL).first {
      $0.name == "portal_session" && !$0.value.isEmpty
    }?.value
  }
}

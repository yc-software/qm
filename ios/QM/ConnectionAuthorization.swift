import AuthenticationServices

@MainActor
struct ConnectionRequest {
  static let contextKeys: Set<String> = [
    "composioReturn", "slackReturn", "view", "session", "scope", "seq", "tab",
  ]
  static let outcomeKeys: Set<String> = ["status", "error", "connectedAccountId", "connector"]
  let authorizeURL: URL
  let state: String
  let destination: URL
  private let base: URL

  init(body: Any, base: URL) throws {
    guard let body = body as? [String: String], let address = body["authorizeUrl"],
      address.utf16.count <= 16_384, let authorizeURL = URL(string: address),
      authorizeURL.scheme == "https", authorizeURL.host?.isEmpty == false,
      authorizeURL.user == nil, authorizeURL.password == nil,
      let state = body["state"],
      state.range(of: "^[a-zA-Z0-9_-]{20,100}$", options: .regularExpression) != nil,
      let target = body["returnTo"]
    else { throw QMError.message("Could not verify this connection request.") }
    self.authorizeURL = authorizeURL
    self.state = state
    self.base = base
    destination = try Self.destination(target, base: base, permitted: Self.contextKeys)
  }

  func result(_ callback: URL) throws -> String {
    guard callback.scheme == "qm", callback.host == "connection", callback.path == "/callback",
      callback.port == nil, callback.user == nil, callback.password == nil,
      callback.fragment == nil,
      let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false)
    else { throw QMError.message("Could not verify the connection response.") }
    let outer = try Self.parameters(parts, permitted: ["state", "returnTo"], maximum: 4096)
    guard outer["state"] == state, let raw = outer["returnTo"] else {
      throw QMError.message("This connection response belongs to another attempt.")
    }
    let returned = try Self.destination(
      raw, base: base, permitted: Self.contextKeys.union(Self.outcomeKeys))
    let expectedParts = URLComponents(url: destination, resolvingAgainstBaseURL: false)!
    let resultParts = URLComponents(url: returned, resolvingAgainstBaseURL: false)!
    let expected = try Self.parameters(expectedParts, permitted: Self.contextKeys)
    let actual = try Self.parameters(
      resultParts, permitted: Self.contextKeys.union(Self.outcomeKeys))
    guard returned.path == destination.path,
      actual.filter({ Self.contextKeys.contains($0.key) }) == expected
    else {
      throw QMError.message("This connection response has an unexpected destination.")
    }
    return resultParts.percentEncodedPath + (resultParts.percentEncodedQuery.map { "?" + $0 } ?? "")
  }

  private static func destination(_ raw: String, base: URL, permitted: Set<String>) throws -> URL {
    guard raw.utf16.count <= 4096, raw.hasPrefix("/"), !raw.hasPrefix("//"),
      !raw.contains("\\"), !raw.contains("\r"), !raw.contains("\n"),
      let target = URL(string: raw, relativeTo: base)?.absoluteURL,
      APIClient.sameOrigin(target, base), target.fragment == nil,
      target.path.range(of: "^/(settings|keychain|s/[a-zA-Z0-9_-]+)?$", options: .regularExpression)
        != nil,
      let parts = URLComponents(url: target, resolvingAgainstBaseURL: false)
    else { throw QMError.message("This connection destination is not supported.") }
    _ = try parameters(parts, permitted: permitted)
    return target
  }

  private static func parameters(_ parts: URLComponents, permitted: Set<String>, maximum: Int = 512)
    throws -> [String: String]
  {
    var result: [String: String] = [:]
    for item in parts.queryItems ?? [] {
      guard permitted.contains(item.name), result[item.name] == nil, let value = item.value,
        value.utf16.count <= maximum
      else { throw QMError.message("Could not verify connection parameters.") }
      result[item.name] = value
    }
    return result
  }
}

@MainActor
final class ConnectionAuthorization {
  private let authentication = WebAuthentication()

  func cancel() {
    authentication.cancel()
  }

  func authorize(_ request: ConnectionRequest, client: APIClient) async throws -> String {
    let generation = client.generation
    let callback = try await authentication.open(request.authorizeURL)
    guard client.generation == generation, client.hasSession else {
      throw CancellationError()
    }
    return try request.result(callback)
  }
}

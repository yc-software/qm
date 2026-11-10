import AuthenticationServices
import CryptoKit

@MainActor
final class SignIn {
  private let authentication: WebAuthentication

  init(
    authentication: WebAuthentication = WebAuthentication(
      callbackScheme: "qm-desktop", prefersEphemeralSession: false)
  ) {
    self.authentication = authentication
  }
  private var attemptID: UUID?

  func cancel() {
    authentication.cancel()
    attemptID = nil
  }

  func authenticate(client: APIClient) async throws {
    guard attemptID == nil else { throw QMError.message("Finish the current sign-in first.") }
    let generation = client.generation
    let attempt = UUID()
    attemptID = attempt
    defer {
      if attemptID == attempt {
        attemptID = nil
      }
    }
    let verifier = try randomToken()
    let state = try randomToken()
    let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
    let url = client.url(
      "auth/desktop",
      query: [
        URLQueryItem(name: "challenge", value: challenge),
        URLQueryItem(name: "state", value: state),
      ])
    let callback = try await authentication.open(url)
    guard attemptID == attempt, client.generation == generation else { throw CancellationError() }
    guard callback.scheme == "qm-desktop", callback.host == "auth", callback.path == "/callback",
      let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
      query.filter({ $0.name == "state" }).count == 1,
      query.first(where: { $0.name == "state" })?.value == state,
      query.filter({ $0.name == "code" }).count == 1,
      let code = query.first(where: { $0.name == "code" })?.value, !code.isEmpty
    else {
      throw QMError.message("Could not verify the sign-in response.")
    }
    let session = try await client.redeemSignIn(code: code, verifier: verifier, state: state)
    try Task.checkCancellation()
    guard attemptID == attempt, client.generation == generation else { throw CancellationError() }
    try client.saveSession(session)
  }

  private func randomToken() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw QMError.message("Could not initialize secure sign-in.")
    }
    return Data(bytes).base64URL
  }
}

extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

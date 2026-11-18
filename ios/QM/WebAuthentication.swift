import AuthenticationServices

@MainActor
final class WebAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
  struct Browser {
    let start: () -> Bool
    let cancel: () -> Void
  }

  typealias Completion = @Sendable (URL?, (any Error)?) -> Void
  typealias Factory = (URL, @escaping Completion) -> Browser

  private struct Pending {
    let id: UUID
    let continuation: CheckedContinuation<URL, any Error>
    let browser: Browser
  }

  private let callbackScheme: String
  private let factory: Factory?
  private var pending: Pending?

  init(callbackScheme: String = "qm", factory: Factory? = nil) {
    self.callbackScheme = callbackScheme
    self.factory = factory
  }

  func cancel() {
    guard let pending else { return }
    finish(pending.id, result: .failure(CancellationError()))
    pending.browser.cancel()
  }

  func open(_ url: URL) async throws -> URL {
    try Task.checkCancellation()
    guard pending == nil else {
      throw QMError.message("Finish the current authorization first.")
    }
    let id = UUID()
    let result = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let completion: Completion = { [weak self] url, error in
          Task { @MainActor in
            let result: Result<URL, any Error>
            if let error {
              result = .failure(Self.normalized(error))
            } else if let url {
              result = .success(url)
            } else {
              result = .failure(QMError.message("Authorization did not complete."))
            }
            self?.finish(id, result: result)
          }
        }
        let browser = factory?(url, completion) ?? makeBrowser(url, completion: completion)
        pending = Pending(id: id, continuation: continuation, browser: browser)
        if !browser.start() {
          finish(id, result: .failure(QMError.message("Could not open authorization.")))
          browser.cancel()
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        guard self?.pending?.id == id else { return }
        self?.cancel()
      }
    }
    try Task.checkCancellation()
    return result
  }

  private func finish(_ id: UUID, result: Result<URL, any Error>) {
    guard let pending, pending.id == id else { return }
    self.pending = nil
    pending.continuation.resume(with: result)
  }

  private static func normalized(_ error: any Error) -> any Error {
    let error = error as NSError
    if error.domain == ASWebAuthenticationSessionErrorDomain,
      error.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue
    {
      return CancellationError()
    }
    return error
  }

  private func makeBrowser(_ url: URL, completion: @escaping Completion) -> Browser {
    let session = ASWebAuthenticationSession(
      url: url, callback: .customScheme(callbackScheme), completionHandler: completion)
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    return Browser(start: { session.start() }, cancel: { session.cancel() })
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }
}

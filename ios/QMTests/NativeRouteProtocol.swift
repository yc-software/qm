import Foundation
import os

@testable import QM

final class NativeRouteProtocol: URLProtocol, @unchecked Sendable {
  struct Reply {
    var status = 200
    var body = "{}"
    var failure: URLError.Code?
    var headers: [String: String]?
  }
  struct Call {
    let method: String
    let url: URL
    let body: Data
    let headers: [String: String]
    var route: String { "\(method) \(url.path)" }
    var exact: String { "\(route)?\(query ?? "")" }
    var query: String? { url.query }
    var parameters: [String: String] {
      Dictionary(
        (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map {
          ($0.name, $0.value ?? "")
        }, uniquingKeysWith: { $1 })
    }
    var json: [String: Any] {
      (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
    }
  }
  struct State {
    var replies: [String: [Reply]] = [:]
    var fallback = Reply(status: 404)
    var calls: [Call] = []
    var holding: Set<String> = []
    var held: [String: [NativeRouteProtocol]] = [:]
    var onCall: (@Sendable (String) -> Void)?
  }
  final class Server: Sendable {
    let host = "\(UUID().uuidString.lowercased()).example"
    let state: OSAllocatedUnfairLock<State>

    init(fallback: Reply = Reply(status: 404)) {
      state = OSAllocatedUnfairLock(initialState: State(fallback: fallback))
      NativeRouteProtocol.servers.withLock { $0[host] = self }
    }

    var configuration: URLSessionConfiguration {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [NativeRouteProtocol.self]
      return configuration
    }

    @MainActor
    func client(_ replies: [String: [Reply]] = [:], holding: Set<String> = []) -> APIClient {
      state.withLock {
        $0.replies.merge(replies) { $1 }
        $0.holding.formUnion(holding)
      }
      return APIClient(baseURL: URL(string: "https://\(host)")!, configuration: configuration)
    }

    var calls: [Call] { state.withLock { $0.calls } }

    func calls(to route: String) -> [Call] { calls.filter { $0.route == route } }

    func reply(_ route: String, status: Int = 200, _ body: String) {
      state.withLock { $0.replies[route] = [Reply(status: status, body: body)] }
    }

    func hold(_ route: String) {
      state.withLock { _ = $0.holding.insert(route) }
    }

    func isHeld(_ route: String) -> Bool {
      state.withLock { $0.held[route]?.isEmpty == false }
    }

    func release(_ route: String) {
      let held = state.withLock { state in
        state.holding.remove(route)
        return state.held.removeValue(forKey: route) ?? []
      }
      for request in held { request.respond() }
    }
  }

  private static let servers = OSAllocatedUnfairLock(initialState: [String: Server]())
  private let stopped = OSAllocatedUnfairLock(initialState: false)

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  private var server: Server? { Self.servers.withLock { $0[request.url!.host ?? ""] } }

  private var keys: [String] = []

  override func startLoading() {
    let call = Call(
      method: request.httpMethod ?? "GET", url: request.url!, body: request.bodyData,
      headers: request.allHTTPHeaderFields ?? [:])
    let keys = [call.exact, call.route]
    self.keys = keys
    let server = server
    let held = server?.state.withLock { state -> Bool in
      state.calls.append(call)
      guard let key = keys.first(where: state.holding.contains) else { return false }
      state.held[key, default: []].append(self)
      return true
    }
    server?.state.withLock { $0.onCall }?(call.route)
    if held != true { respond() }
  }

  private func respond() {
    guard !stopped.withLock({ $0 }) else { return }
    let keys = keys
    let reply =
      server?.state.withLock { state -> Reply in
        guard let key = keys.first(where: { state.replies[$0]?.isEmpty == false }) else {
          return state.fallback
        }
        return state.replies[key]!.count > 1
          ? state.replies[key]!.removeFirst() : state.replies[key]![0]
      } ?? Reply(status: 404)
    if let failure = reply.failure {
      client?.urlProtocol(self, didFailWithError: URLError(failure))
      return
    }
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: reply.headers)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() { stopped.withLock { $0 = true } }
}

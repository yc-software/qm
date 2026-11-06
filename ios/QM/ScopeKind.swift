enum ScopeKind: String {
  case personal, group, channel, project

  init?(scopeId: String) {
    self.init(rawValue: String(scopeId.prefix { $0 != ":" }))
  }
}

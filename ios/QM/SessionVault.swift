import Foundation
import Security

struct SessionVault {
  let account: String

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "org.qm.portal-session",
      kSecAttrAccount as String: account,
    ]
  }

  func read() -> String? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func write(_ token: String) throws {
    let data = Data(token.utf8)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var request = query
      request[kSecValueData as String] = data
      request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else {
        throw QMError.message("Could not securely save your session.")
      }
    } else if status != errSecSuccess {
      throw QMError.message("Could not securely update your session.")
    }
  }

  func delete() { SecItemDelete(query as CFDictionary) }
}

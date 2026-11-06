import CryptoKit

extension SHA256.Digest {
  var hex: String { map { String(format: "%02x", $0) }.joined() }
}

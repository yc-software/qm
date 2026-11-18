import Foundation

extension URLRequest {
  var bodyData: Data {
    if let httpBody { return httpBody }
    guard let stream = httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while case let count = stream.read(&buffer, maxLength: buffer.count), count > 0 {
      data.append(buffer, count: count)
    }
    return data
  }
}

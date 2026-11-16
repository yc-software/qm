import SwiftUI
import UIKit

struct NativeAudioPermissionNotice: View {
  let message: String
  let permission: NativeAudioPermissionError?
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(message).font(.footnote).foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
      if permission?.canOpenSettings == true {
        Button("Open Settings") {
          if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        }
        .font(.footnote.weight(.semibold))
        .frame(minHeight: 44)
        .accessibilityHint("Opens QM's permissions in Settings")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

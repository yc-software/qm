import SwiftUI

struct NativeChatGPTLogo: View {
  var size: CGFloat = 20
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    Image("Service-openai")
      .resizable()
      .renderingMode(.template)
      .scaledToFit()
      .frame(width: size, height: size)
      .foregroundStyle(colorScheme == .dark ? Color.white : Color.black)
      .accessibilityHidden(true)
  }
}

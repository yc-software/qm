import SwiftUI

struct NativeConversationDrawer<Sidebar: View, Detail: View>: View {
  @Binding var isOpen: Bool
  let hasSelection: Bool
  var showsSidebarPage = false
  @ViewBuilder let sidebar: () -> Sidebar
  @ViewBuilder let detail: () -> Detail
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geometry in
      let sidebarWidth = min(geometry.size.width * 0.8, 400)
      ZStack(alignment: .leading) {
        sidebar()
          .frame(width: hasSelection && !showsSidebarPage ? sidebarWidth : geometry.size.width)
          .allowsHitTesting(!hasSelection || isOpen || showsSidebarPage)
          .accessibilityHidden(hasSelection && !isOpen && !showsSidebarPage)
        if hasSelection {
          detail()
            .frame(width: geometry.size.width)
            .background(QMTheme.paper.ignoresSafeArea(.container, edges: .vertical))
            .disabled(isOpen || showsSidebarPage)
            .accessibilityHidden(isOpen || showsSidebarPage)
            .overlay {
              if isOpen {
                Button {
                  isOpen = false
                } label: {
                  QMTheme.paper.opacity(0.3)
                    .ignoresSafeArea(.container, edges: .vertical)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Return to conversation")
                .accessibilityIdentifier("closeConversationDrawer")
                .gesture(
                  DragGesture().onEnded { value in
                    if value.translation.width < -30 { isOpen = false }
                  })
              }
            }
            .mask {
              RoundedRectangle(cornerRadius: isOpen ? 32 : 0)
                .ignoresSafeArea(.container, edges: .vertical)
            }
            .overlay {
              if isOpen {
                RoundedRectangle(cornerRadius: 32).strokeBorder(QMTheme.border)
                  .ignoresSafeArea(.container, edges: .vertical)
                  .allowsHitTesting(false)
              }
            }
            .shadow(color: .black.opacity(isOpen ? 0.08 : 0), radius: 16, x: -4)
            .offset(x: isOpen ? sidebarWidth : 0)
            .opacity(showsSidebarPage ? 0 : 1)
            .allowsHitTesting(!showsSidebarPage)

        }
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
      .mask { Rectangle().ignoresSafeArea(.container, edges: .vertical) }
      .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: isOpen)
    }
    .background(QMTheme.paper.ignoresSafeArea())
    .sensoryFeedback(trigger: isOpen) { _, _ in
      hasSelection && !showsSidebarPage ? .impact(flexibility: .soft, intensity: 0.7) : nil
    }
  }
}

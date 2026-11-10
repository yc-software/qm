import SwiftUI

struct StudyGallery: View {
  @State private var selected: StudyBrand? = {
    let args = ProcessInfo.processInfo.arguments
    guard let index = args.firstIndex(of: "-study"), args.indices.contains(index + 1) else {
      return nil
    }
    return StudyBrand(rawValue: args[index + 1])
  }()

  var body: some View {
    Group {
      if let selected {
        switch selected {
        case .revolut: RevolutStudy(onClose: close)
        case .waymo: WaymoStudy(onClose: close)
        case .grok: GrokStudy(onClose: close)
        case .openai: OpenAIStudy(onClose: close)
        case .flighty: FlightyStudy(onClose: close)
        }
      } else {
        gallery
      }
    }
  }

  private var gallery: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 30) {
        HStack {
          Text("qm").font(.system(.largeTitle, design: .rounded, weight: .black))
          Spacer()
          Text("DESIGN STUDIES / 01")
            .font(.system(.caption2, design: .monospaced, weight: .medium))
            .tracking(1.3)
            .foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 12) {
          Text("One QM.\nFive perspectives.")
            .font(.system(.largeTitle, weight: .semibold))
            .tracking(-1.3)
            .fixedSize(horizontal: false, vertical: true)
          Text("The same intelligent workspace, seen through five distinct design languages.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineSpacing(4)
        }
        VStack(spacing: 14) {
          ForEach(StudyBrand.allCases) { brand in
            Button {
              selected = brand
            } label: {
              StudyGalleryCard(brand: brand)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("study-\(brand.rawValue)")
          }
        }
        Text(
          "Independent design concepts. Sample conversations and simulated replies. No affiliation with the referenced companies."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineSpacing(3)
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 20)
      .frame(maxWidth: 600)
      .frame(maxWidth: .infinity)
    }
    .background(Color(red: 0.985, green: 0.98, blue: 0.965))
    .preferredColorScheme(.light)
  }

  private func close() {
    selected = nil
  }
}

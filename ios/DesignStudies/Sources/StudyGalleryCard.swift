import SwiftUI

struct StudyGalleryCard: View {
  let brand: StudyBrand

  var body: some View {
    HStack(alignment: .center, spacing: 18) {
      Image(systemName: brand.symbol)
        .font(.system(.title, weight: .semibold))
        .foregroundStyle(brand.accent)
        .frame(width: 44, height: 58)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 7) {
        Text(brand.title)
          .font(.system(.title3, weight: .semibold))
        Text(brand.subtitle)
          .font(.footnote)
          .foregroundStyle(brand.dark ? .white.opacity(0.65) : .black.opacity(0.60))
          .multilineTextAlignment(.leading)
      }
      Spacer(minLength: 0)
      Image(systemName: "arrow.up.right")
        .font(.system(.subheadline, weight: .medium))
        .foregroundStyle(brand.dark ? .white.opacity(0.65) : .black.opacity(0.60))
        .accessibilityHidden(true)
    }
    .foregroundStyle(brand.dark ? .white : .black)
    .padding(22)
    .frame(minHeight: 110)
    .background(brand.surface, in: .rect(cornerRadius: 24))
    .contentShape(.rect(cornerRadius: 24))
  }
}

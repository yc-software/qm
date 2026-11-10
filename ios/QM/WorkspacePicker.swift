import SwiftUI

struct WorkspacePicker: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var error: String?
  @FocusState private var addressFocused: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "network")
              .font(.system(size: 25, weight: .semibold))
              .foregroundStyle(.white)
              .frame(width: 52, height: 52)
              .background(QMTheme.navy, in: RoundedRectangle(cornerRadius: 8))
              .accessibilityHidden(true)
            Text("Connect a workspace")
              .font(.title2.weight(.bold))
            Text("Enter the address your QM workspace uses.")
              .font(.body).foregroundStyle(.secondary)
          }

          VStack(alignment: .leading, spacing: 10) {
            Text("Workspace address").font(.headline)
            HStack(spacing: 10) {
              Image(systemName: "globe").foregroundStyle(.secondary)
              TextField("qm.example.com", text: $address)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.URL)
                .submitLabel(.continue)
                .focused($addressFocused)
                .onSubmit(connect)
                .accessibilityIdentifier("workspaceAddress")
              if !address.isEmpty {
                Button {
                  address = ""
                  error = nil
                } label: {
                  Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Clear workspace address")
              }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
              RoundedRectangle(cornerRadius: 8)
                .stroke(error == nil ? QMTheme.border : Color.red.opacity(0.7), lineWidth: 1)
            }

            if let error {
              Label(error, systemImage: "exclamationmark.circle.fill")
                .font(.footnote).foregroundStyle(.red)
            } else {
              Text(AppModel.workspaceAddressHint)
                .font(.footnote).foregroundStyle(.secondary)
            }
          }

          if model.identity != nil {
            Label(
              "Changing workspaces signs you out and clears local drafts for this account.",
              systemImage: "person.crop.circle.badge.minus"
            )
            .font(.footnote).foregroundStyle(.secondary)
          }
        }
        .foregroundStyle(QMTheme.ink)
        .padding(24)
        .frame(maxWidth: 560, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .background(QMTheme.paper)
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          Button(action: connect) {
            HStack {
              Text("Use this workspace").fontWeight(.semibold)
              Spacer()
              Image(systemName: "arrow.right")
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .tint(QMTheme.navy)
          .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .padding(.horizontal, 24).padding(.vertical, 14)
          .background(.regularMaterial)
        }
      }
      .navigationTitle("Workspace")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
          }
          .accessibilityLabel("Cancel")
        }
      }
      .onAppear { address = model.client?.baseURL.absoluteString ?? "" }
      .onChange(of: address) { error = nil }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  private func connect() {
    addressFocused = false
    error = nil
    do {
      try model.selectWorkspace(address)
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

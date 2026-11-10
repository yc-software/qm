import SwiftUI

struct WorkspacePicker: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var error: String?

  var body: some View {
    NavigationStack {
      QMForm {
        Section("Workspace address") {
          TextField("https://qm.example.com", text: $address)
            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            .textContentType(.URL).accessibilityIdentifier("workspaceAddress")
        }
        if model.identity != nil {
          Text("Changing workspaces signs you out and clears local drafts for the current account.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .navigationTitle("Workspace")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Connect") {
            do {
              try model.selectWorkspace(address)
              dismiss()
            } catch { self.error = error.localizedDescription }
          }.disabled(
            model.loading || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .onAppear { address = model.client?.baseURL.absoluteString ?? "" }
    }
  }
}

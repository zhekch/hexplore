import SwiftUI

/// The app's own settings, which are few on purpose.
///
/// Everything about your *map* — importing, syncing, backups, colours, home,
/// statistics — lives in the web app's own menu on the Map tab, where it already
/// works and where a laptop finds it in the same place. Duplicating any of it
/// here would mean two screens that have to agree.
///
/// What is left is the handful of things only this app can answer: which server
/// to open, and how to forget it.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings

    @State private var draft = ""
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("hexplore.your-tailnet.ts.net", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit(commit)

                    if draft.trimmingCharacters(in: .whitespacesAndNewlines) != settings.serverURL {
                        Button("Connect", action: commit)
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Where you open Hexplore. A plain `http://` address works on your own network; anything else needs HTTPS — `tailscale serve` in front of `npm start` gives you one reachable only from your devices.")
                }

                if settings.isConfigured {
                    Section {
                        Button("Reload") { settings.reload() }
                        Button("Sign out", role: .destructive) { confirmingSignOut = true }
                    } footer: {
                        Text("Signing out forgets the site's cookies and stored data on this device. Your map is on the server and is not touched.")
                    }
                }

                Section {
                    LabeledContent("Version", value: Self.version)
                } footer: {
                    Text("The map, the menu and everything in it are the web app itself, running on this phone. A fix there is a fix here.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                "Sign out of Hexplore?",
                isPresented: $confirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) {
                    Task { await settings.signOut() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .onAppear { draft = settings.serverURL }
    }

    private func commit() {
        settings.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}

#Preview {
    SettingsView().environmentObject(AppSettings())
}

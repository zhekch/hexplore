import SwiftUI

/// The second tab: everything that is not the map.
///
/// Once a server is set this is the web app itself — its menu, import and sync
/// dialogs, statistics and backups, in a web view. Before one is set it is the
/// one form this app owns, because a web view pointed at nothing is a white
/// rectangle that cannot explain itself.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings

    @State private var draft = ""
    @State private var reloadToken = 0
    @State private var editing = false

    var body: some View {
        NavigationStack {
            Group {
                if let url = settings.baseURL, !editing {
                    WebPanel(url: url, reloadToken: $reloadToken)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    serverForm
                }
            }
            .navigationTitle(editing || !settings.isConfigured ? "Server" : "Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if settings.isConfigured {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        if editing {
                            Button("Done") { commit() }
                        } else {
                            Menu {
                                Button("Reload") { reloadToken += 1 }
                                Button("Change server") {
                                    draft = settings.serverURL
                                    editing = true
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                        }
                    }
                }
            }
        }
        .onAppear { draft = settings.serverURL }
    }

    private var serverForm: some View {
        Form {
            Section {
                TextField("hexplore.your-tailnet.ts.net", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .onSubmit(commit)
            } header: {
                Text("Server address")
            } footer: {
                // Said here rather than discovered as a blank screen: the web
                // view will simply refuse a plain http:// address, and so will
                // the map's "my location" button.
                Text("Where you open Hexplore. **HTTPS is required** — App Transport Security refuses plain http://, and browser geolocation needs a secure origin either way. `tailscale serve` in front of `npm start` gives you an HTTPS address reachable only from your own devices.")
            }

            if settings.isConfigured {
                Section {
                    Button("Open") { commit() }
                }
            }
        }
    }

    private func commit() {
        settings.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if settings.isConfigured {
            editing = false
            reloadToken += 1
        }
    }
}

#Preview {
    SettingsView().environmentObject(AppSettings())
}

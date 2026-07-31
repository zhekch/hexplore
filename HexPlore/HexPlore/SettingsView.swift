import SwiftUI

/// The second tab: everything that is not the map.
///
/// Three states, in the order you meet them — no server yet, not signed in, and
/// then the web app's own menu, which is where the import, sync, statistics,
/// backup and export settings all live.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: Session

    @State private var draft = ""
    @State private var reloadToken = 0
    @State private var editingServer = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        .onAppear { draft = settings.serverURL }
    }

    @ViewBuilder
    private var content: some View {
        if editingServer || !settings.isConfigured {
            serverForm
        } else {
            switch session.state {
            case .unconfigured:
                serverForm
            case .checking:
                ProgressView("Connecting…")
            case .signedOut:
                LoginView()
            case .signedIn:
                if let url = settings.baseURL {
                    WebPanel(url: url, reloadToken: $reloadToken) { webView in
                        await session.adoptCookies(into: webView)
                    }
                    .ignoresSafeArea(edges: .bottom)
                }
            }
        }
    }

    private var title: String {
        if editingServer || !settings.isConfigured { return "Server" }
        if case .signedIn = session.state { return "Settings" }
        return "Sign in"
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if settings.isConfigured, !editingServer {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    if case .signedIn = session.state {
                        Button("Reload") { reloadToken += 1 }
                        Button("Refresh map") { Task { await session.loadCells() } }
                    }
                    Button("Change server") {
                        draft = settings.serverURL
                        editingServer = true
                    }
                    if case .signedIn(let name) = session.state {
                        Divider()
                        Button("Sign out (\(name))", role: .destructive) {
                            Task { await session.signOut() }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        } else if settings.isConfigured, editingServer {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Done") { commitServer() }
            }
        }
    }

    private var serverForm: some View {
        Form {
            Section {
                TextField("hexplore.your-tailnet.ts.net", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .onSubmit(commitServer)
            } header: {
                Text("Server address")
            } footer: {
                // Said here rather than discovered as a blank screen.
                Text("Where you open Hexplore. **Use HTTPS** — `tailscale serve` in front of `npm start` gives you an address reachable only from your own devices. A plain http:// address works only on your local network.")
            }

            Section {
                Button("Connect") { commitServer() }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func commitServer() {
        settings.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard settings.isConfigured else { return }
        editingServer = false
        reloadToken += 1
        Task { await session.use(baseURL: settings.baseURL) }
    }
}

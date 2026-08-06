// `Combine` explicitly — this target turns on MemberImportVisibility, so a
// transitive import does not lend its members, and `onReceive` wants a publisher.
import AppKit
import Combine
import SwiftUI

/// The window, which is the web app and nothing else.
///
/// **Map** is the site — all of it, unmodified. The map, the menu, the import
/// dialogs, the sync connectors, statistics and backups already work and already
/// have their own login; the Mac hosts them rather than replacing them.
///
/// **Settings** is the little this app knows that the site does not: which
/// server to open, what this Mac records about where it has been, and how to
/// forget both. On the phone that is the second tab; here it is ⌘, like
/// everything else on this machine.
///
/// The derived data behind all of it — trips, coverage, the calendar — is worked
/// out once by the server (`server/derive.js`), so a Mac, a phone and a laptop
/// cannot disagree about what they show.
struct ContentView: View {
    @StateObject private var settings = AppSettings.shared

    var body: some View {
        Group {
            if let url = settings.baseURL {
                WebPanel(url: url, reloadToken: settings.reloadToken)
            } else {
                unconfigured
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        // Resigning active is the Mac's version of the moment the phone app
        // pushes on: you have gone somewhere else, and whatever is queued may as
        // well go now. Quitting is caught separately, in `AppDelegate`.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in
            Task { await SyncClient.shared.flush() }
        }
        // The site is dark — its login card, its menu, and three of its four
        // basemaps — so the window it sits in is too. Fixed rather than
        // adaptive, because the thing it is matched to is fixed.
        .preferredColorScheme(.dark)
    }

    /// A web view pointed at nothing is a white rectangle that cannot explain
    /// itself, so this says what is missing and opens the place to put it.
    private var unconfigured: some View {
        VStack(spacing: 14) {
            Image(systemName: "globe.europe.africa")
                .font(.system(size: 44))
                .foregroundStyle(.tertiary)
            Text("No server yet")
                .font(.headline)
            Text("Add the address you open Hexplore at in Settings.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            SettingsLink {
                Text("Open Settings")
            }
            .padding(.top, 4)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    ContentView()
}

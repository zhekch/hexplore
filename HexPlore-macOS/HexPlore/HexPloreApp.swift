//
//  HexPloreApp.swift
//  HexPlore for macOS
//

import AppKit
import SwiftUI

/// One window with the map in it, and a Settings window behind ⌘,.
///
/// The iPhone app puts those two on a tab bar, which is what a phone has. A Mac
/// has a menu bar, so the second one lives where every Mac app keeps its
/// settings and is reachable from the same keystroke as everyone else's.
///
/// `Window` rather than `WindowGroup`, and that is not cosmetic: a group lets
/// ⌘N open a second copy, and a second copy here means a second `WKWebView`,
/// a second service worker registration and a second map holding the same tiles
/// in memory. There is one map.
@main
struct HexPloreApp: App {
    // The Mac equivalent of the iPhone app's launch hook, and it is here for a
    // much smaller reason: nothing relaunches this app behind your back, so all
    // this catches is ordinary launch and ordinary quit. The quit half is the
    // one that matters — see `applicationShouldTerminate`.
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("HexPlore", id: "map") {
            ContentView()
        }
        .defaultSize(width: 1180, height: 820)
        .commands {
            // The web app has no reload of its own — it is a page, and a page is
            // reloaded by its host. ⌘R is where every browser keeps that.
            CommandGroup(after: .toolbar) {
                Button("Reload Map") { AppSettings.shared.reload() }
                    .keyboardShortcut("r", modifiers: .command)
            }
            // ⌘N would open a second window of a `Window` scene's content in
            // some SwiftUI versions and does nothing useful in the rest. There
            // is one map, so the command is removed rather than left to be
            // pressed and wondered about.
            CommandGroup(replacing: .newItem) {}
        }

        Settings {
            SettingsView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Idempotent, and does nothing at all when the switch is off — which is
        // where it starts on a Mac. See `TrackingSettings.Cadence`.
        MainActor.assumeIsolated {
            LocationLogger.shared.resume()
        }
    }

    /// Closing the window is not quitting.
    ///
    /// It would be, for an app that is only a window. This one may be recording
    /// where the Mac has been, and a logger that stops the moment you press the
    /// red button is a logger that silently keeps half a day. The app stays in
    /// the Dock; ⌘Q is how you mean it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// A last push on the way out, with a ceiling on how long it may take.
    ///
    /// Quitting is the same moment the iPhone app pushes on: the queue is as
    /// full as it is going to get and the process is about to stop existing.
    /// The difference is that a Mac can be told to wait, so it is asked to —
    /// but only for three seconds. Nothing is lost by giving up: a fix leaves
    /// `FixQueue` when the server has answered 200 and not before, so the worst
    /// case of a cancelled push is that the next launch sends it again.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !leaving else { return .terminateNow }
        leaving = true
        Task {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await SyncClient.shared.flush(force: true) }
                group.addTask { try? await Task.sleep(for: .seconds(3)) }
                // Whichever comes first — the push finishing, or the patience
                // running out.
                await group.next()
                group.cancelAll()
            }
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private var leaving = false
}

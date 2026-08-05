//
//  HexPloreApp.swift
//  HexPlore
//
//  Created by Zhenya Danyliuk on 31.07.2026.
//

import SwiftUI
import UIKit

@main
struct HexPloreApp: App {
    // SwiftUI has no hook for the launch that matters most here. When iOS
    // relaunches this app *for* a location event there is no window, no scene
    // and no view — only `didFinishLaunchingWithOptions`, and about a second in
    // which to restart the services that caused the launch. Miss it and the
    // event is delivered to nobody, which looks from the outside exactly like a
    // logger that stops working whenever the app is swiped away.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Neither needs to know *why* it was launched: both are idempotent, and
        // both do nothing at all when their switch is off.
        MainActor.assumeIsolated {
            LocationLogger.shared.resume()
            HealthSync.shared.apply()
        }
        return true
    }
}

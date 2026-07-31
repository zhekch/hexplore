import SwiftUI

/// Signing in, natively.
///
/// It happens here rather than in the web view because the map tab needs the
/// session too, and a session the map cannot see is no use to it. The cookie is
/// handed to the web view afterwards, so this is the only sign-in on the device.
struct LoginView: View {
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var settings: AppSettings

    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        Form {
            Section {
                TextField("Username", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .username)
                    .onSubmit { focus = .password }

                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .onSubmit(submit)
            } header: {
                Text(settings.serverURL)
                    .textCase(nil)
            } footer: {
                if case .signedOut(let message) = session.state, let message {
                    Text(message).foregroundStyle(.red)
                }
            }

            Section {
                Button("Sign in", action: submit)
                    .disabled(username.isEmpty || password.isEmpty || busy)
            }
        }
        .navigationTitle("Sign in")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(busy)
        .overlay {
            if busy { ProgressView() }
        }
    }

    private var busy: Bool { session.state == .checking }

    private func submit() {
        guard !username.isEmpty, !password.isEmpty else { return }
        Task { await session.signIn(username: username, password: password) }
    }
}

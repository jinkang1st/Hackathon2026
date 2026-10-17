import AppKit
import ApplicationServices
import Foundation
import MessageGuardCore

let help = """
AI Firewall · macOS message reminders

Usage: MessageGuard [--app <bundle-id> ...] [--server <url>] [--preview] [--start] [--diagnostics]
Permissions: MessageGuard --check-permissions
Example: MessageGuard --app com.apple.TextEdit --server http://127.0.0.1:8000

Set FIREWALL_API_TOKEN in the launch environment if your backend requires a token.
The app starts paused. Use its shield menu to enable or pause protection.
Without --app, configure allowed applications from the shield menu first.
--start opens the normal enable confirmation after launch; it does not skip consent.
--diagnostics prints processing stages only, without draft text, key characters, or credentials.
Keyboard characters and draft text are never written to logs or disk.
Only supported editable fields in the specified apps are checked.
This version shows reminders while typing; it does not block message sending.
"""

var applications = Set<String>()
var server = "http://127.0.0.1:8000"
var preview = false
var requestStartOnLaunch = false
var diagnostics = false
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--check-permissions"] {
    print("Accessibility: " + (AXIsProcessTrusted() ? "granted" : "not granted"))
    print("Input Monitoring: " + (CGPreflightListenEventAccess() ? "granted" : "not granted"))
    exit(0)
}
var index = 0
while index < arguments.count {
    let argument = arguments[index]
    if argument == "--help" || argument == "-h" { print(help); exit(0) }
    if argument == "--preview" { preview = true; index += 1; continue }
    if argument == "--start" { requestStartOnLaunch = true; index += 1; continue }
    if argument == "--diagnostics" { diagnostics = true; index += 1; continue }
    guard index + 1 < arguments.count, ["--app", "--server"].contains(argument) else {
        fputs("Invalid arguments. Use --help for usage.\n", stderr)
        exit(2)
    }
    if argument == "--app" { applications.insert(arguments[index + 1]) }
    if argument == "--server" { server = arguments[index + 1] }
    index += 2
}
guard applications.allSatisfy({ !$0.isEmpty && $0.contains(".") }),
      let url = URL(string: server) else {
    fputs("Invalid application bundle ID or server URL. Use --help for usage.\n", stderr)
    exit(2)
}

do {
    let client = try BackendClient(
        baseURL: url, token: ProcessInfo.processInfo.environment["FIREWALL_API_TOKEN"]
    )
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let delegate = AppDelegate(allowed: applications, backend: client, preview: preview,
                                   requestStartOnLaunch: requestStartOnLaunch, diagnostics: diagnostics)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
} catch {
    fputs("Invalid backend URL. Use HTTPS or HTTP on a loopback address.\n", stderr)
    exit(2)
}

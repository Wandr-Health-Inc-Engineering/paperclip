// Tethr Command Center — native macOS shell.
//
// A standalone app window (NO browser) that hosts the existing zero-dependency
// Command Center web UI in a WKWebView, booting its Node server as a hidden
// child process on a private loopback port. Closing the window stops the server
// and quits. On-brand: a transparent black titlebar with the web UI painting its
// own chrome right up to the traffic lights — a "hybrid preview + Finder" window.
//
// Nothing here changes the server or the UI: it just wraps them. The server is
// still loopback-only and root-confined; this shell adds no privilege.

import AppKit
import WebKit
import Darwin

// ---------------------------------------------------------------------------
// Locating the server + Node
// ---------------------------------------------------------------------------

/// Where the Command Center server lives, in priority order:
///  1. TETHR_CC_DIR (explicit override)
///  2. the copy bundled inside this .app (self-contained build)
///  3. the repo checkout (dev fallback)
private func serverScriptPath() -> String? {
    var dirs: [String] = []
    if let env = ProcessInfo.processInfo.environment["TETHR_CC_DIR"], !env.isEmpty { dirs.append(env) }
    if let res = Bundle.main.resourceURL?.appendingPathComponent("command-center").path { dirs.append(res) }
    dirs.append("/Users/markkaram/git/paperclip/scripts/tethr-command-center")
    for dir in dirs {
        let p = (dir as NSString).appendingPathComponent("server.mjs")
        if FileManager.default.fileExists(atPath: p) { return p }
    }
    return nil
}

/// A double-clicked app has a bare PATH, so find `node` explicitly. Check the
/// common install locations first, then ask a login shell (covers nvm/fnm/asdf).
private func findNode() -> String? {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        (NSHomeDirectory() as NSString).appendingPathComponent(".volta/bin/node"),
        (NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/node"),
    ]
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }

    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: shell)
    p.arguments = ["-lc", "command -v node"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    let path = String(data: data, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return (!path.isEmpty && FileManager.default.isExecutableFile(atPath: path)) ? path : nil
}

/// Ask the kernel for a free loopback TCP port (bind :0, read it back, release).
/// A tiny race exists before the server rebinds it, but ephemeral ports don't
/// collide in practice. Falls back to the server's own default on any failure.
private func freePort() -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return 4848 }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    addr.sin_port = 0
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    if bound != 0 { return 4848 }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fd, $0, &len)
        }
    }
    let port = Int(UInt16(bigEndian: addr.sin_port))
    return port == 0 ? 4848 : port
}

// ---------------------------------------------------------------------------
// App delegate
// ---------------------------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private let port = freePort()
    private var loaded = false
    private var quitting = false
    private var logTail = ""
    private var signalSources: [DispatchSourceSignal] = []

    private var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()
        buildWindow()
        startServer()
    }

    /// Kill the child server on SIGTERM/SIGINT too (a hard kill or crash never
    /// runs applicationWillTerminate, which would otherwise orphan the server).
    /// SIGKILL can't be caught — the server's own parent-liveness watch covers it.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                self?.quitting = true
                self?.server?.terminate()
                exit(0)
            }
            src.resume()
            signalSources.append(src)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
    }

    // -- window ------------------------------------------------------------

    private func buildWindow() {
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 740),
            styleMask: style, backing: .buffered, defer: false)
        window.title = "Tethr Command Center"
        window.titleVisibility = .hidden          // the web UI paints its own title
        window.titlebarAppearsTransparent = true  // seamless into the content
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.backgroundColor = .textBackgroundColor  // dynamic: white / near-black
        window.minSize = NSSize(width: 760, height: 500)
        window.setFrameAutosaveName("TethrCommandCenter")

        // Push the web chrome below the ~34px titlebar strip so the traffic
        // lights and the drag region sit clear of the app's own top bar.
        let css = ".topbar{padding-top:34px !important;}"
        let js = "(function(){var s=document.createElement('style');s.textContent='\(css)';document.head.appendChild(s);})();"
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")  // let the window bg show pre-load
        if #available(macOS 13.3, *) {
            webView.isInspectable = ProcessInfo.processInfo.environment["TETHR_CC_DEBUG"] == "1"
        }
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // -- server ------------------------------------------------------------

    private func startServer() {
        guard let node = findNode() else {
            fail("Node.js wasn't found.\n\nInstall Node 20+ (e.g. `brew install node`) and reopen the app.")
            return
        }
        guard let script = serverScriptPath() else {
            fail("The Command Center server files weren't found next to the app.")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        env["TETHR_CC_PORT"] = String(port)
        env["TETHR_CC_PARENT_PID"] = String(getpid())  // server exits if we vanish
        p.environment = env

        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            FileHandle.standardError.write(data)  // pass through for `Console`/logs
            if let s = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async { self.logTail = String((self.logTail + s).suffix(800)) }
            }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.serverExited() }
        }
        do { try p.run() } catch {
            fail("Couldn't start the server:\n\(error.localizedDescription)")
            return
        }
        server = p
        pollUntilReady(attempt: 0)
    }

    /// Poll the loopback port until the server answers, then load the page.
    /// Robust to however fast the child boots; caps at ~20s.
    private func pollUntilReady(attempt: Int) {
        if loaded || quitting { return }
        if attempt > 66 {
            fail("The Command Center server didn't come up in time.\n\nCheck that the 00 Tethr folder exists (it syncs via Google Drive for Desktop).")
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            DispatchQueue.main.async {
                guard let self, !self.loaded, !self.quitting else { return }
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                    self.loaded = true
                    self.webView.load(URLRequest(url: self.url))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.pollUntilReady(attempt: attempt + 1)
                    }
                }
            }
        }.resume()
    }

    private func serverExited() {
        guard !quitting else { return }
        if !loaded {
            let detail = logTail.trimmingCharacters(in: .whitespacesAndNewlines)
            fail("The Command Center server stopped before it was ready." + (detail.isEmpty ? "" : "\n\n\(detail)"))
        } else {
            // Server died while in use — tell the user and quit cleanly.
            fail("The Command Center server stopped. Reopen the app to continue.")
        }
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Tethr Command Center"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

import Cocoa
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var isRunning = false
    let port = 8787
    let projectDir: String

    override init() {
        let execURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let binDir = execURL.deletingLastPathComponent().path
        if FileManager.default.fileExists(atPath: "\(binDir)/start.sh") {
            self.projectDir = URL(fileURLWithPath: binDir).deletingLastPathComponent().path
        } else {
            self.projectDir = "/Users/noahpage/Desktop/claude-cowork-local-main"
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.isVisible = true

        isRunning = isPortOpen()
        updateStatus()
        buildMenu()

        // Poll every 2 seconds
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.checkStatus()
        }
    }

    func checkStatus() {
        let running = isPortOpen()
        if running != isRunning {
            isRunning = running
            DispatchQueue.main.async {
                self.updateStatus()
                self.buildMenu()
            }
        }
    }

    func isPortOpen() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 0.5

        let semaphore = DispatchSemaphore(value: 0)
        var online = false

        let task = URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode < 500 {
                online = true
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 0.6)
        return online
    }

    func updateStatus() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let button = self.statusItem?.button else { return }
            let dot = self.isRunning ? "🟢" : "⚪️"
            button.title = "\(dot) Cowork"
        }
    }

    func buildMenu() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let menu = NSMenu()

            let statusText = self.isRunning ? "Status: Proxy Online (:8787)" : "Status: Proxy Offline"
            let statusItemMenu = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
            statusItemMenu.isEnabled = false
            menu.addItem(statusItemMenu)

            menu.addItem(NSMenuItem.separator())

            if !self.isRunning {
                let startItem = NSMenuItem(title: "Start Proxy", action: #selector(self.startProxy), keyEquivalent: "s")
                startItem.target = self
                menu.addItem(startItem)

                let launch3pItem = NSMenuItem(title: "Start Proxy & Launch Gateway Mode", action: #selector(self.launchGateway), keyEquivalent: "g")
                launch3pItem.target = self
                menu.addItem(launch3pItem)
            } else {
                let stopItem = NSMenuItem(title: "Stop Proxy", action: #selector(self.stopProxy), keyEquivalent: "x")
                stopItem.target = self
                menu.addItem(stopItem)

                let restartItem = NSMenuItem(title: "Restart Proxy", action: #selector(self.restartProxy), keyEquivalent: "r")
                restartItem.target = self
                menu.addItem(restartItem)
            }

            menu.addItem(NSMenuItem.separator())

            let switchGatewayItem = NSMenuItem(title: "Switch Claude to Gateway Mode (3P)", action: #selector(self.launchGateway), keyEquivalent: "")
            switchGatewayItem.target = self
            menu.addItem(switchGatewayItem)

            let switchNormalItem = NSMenuItem(title: "Switch Claude to Normal Mode (1P)", action: #selector(self.launchNormal), keyEquivalent: "")
            switchNormalItem.target = self
            menu.addItem(switchNormalItem)

            menu.addItem(NSMenuItem.separator())

            let openLogsItem = NSMenuItem(title: "Open Proxy Log", action: #selector(self.openLogs), keyEquivalent: "l")
            openLogsItem.target = self
            menu.addItem(openLogsItem)

            let quitItem = NSMenuItem(title: "Quit Menu Bar App", action: #selector(self.quitApp), keyEquivalent: "q")
            quitItem.target = self
            menu.addItem(quitItem)

            self.statusItem.menu = menu
        }
    }

    @objc func startProxy() {
        runScript("\(projectDir)/bin/start.sh")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.checkStatus()
        }
    }

    @objc func stopProxy() {
        runScript("\(projectDir)/bin/stop.sh")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.checkStatus()
        }
    }

    @objc func restartProxy() {
        runScript("\(projectDir)/bin/stop.sh")
        runScript("\(projectDir)/bin/start.sh")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.checkStatus()
        }
    }

    @objc func launchGateway() {
        runScript("\(projectDir)/bin/launch-gateway.sh")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.checkStatus()
        }
    }

    @objc func launchNormal() {
        runScript("\(projectDir)/bin/launch-normal.sh")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.checkStatus()
        }
    }

    @objc func openLogs() {
        let logPath = ("~/.local/log/claude-cowork-local/worker.log" as NSString).expandingTildeInPath
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc func quitApp() {
        NSApplication.shared.terminate(nil)
    }

    func runScript(_ path: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.launchPath = "/bin/sh"
            task.arguments = [path]
            task.launch()
            task.waitUntilExit()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

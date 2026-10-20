import AppKit
import CoreGraphics

let args = CommandLine.arguments
if args.count != 4 { exit(2) }
let target = pid_t(args[1])!
let ready = args[2]
let stop = args[3]
let workspace = NSWorkspace.shared
let foreground = workspace.frontmostApplication?.processIdentifier
if foreground == nil || foreground == target { exit(3) }
let pointer = CGEvent(source: nil)!.location
var violations = Set<String>()

func order() -> [UInt32] {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return windows.compactMap { info in
        let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue
        guard (pid == target || pid == foreground), layer == 0 else { return nil }
        return (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }
}
let baseline = order()
func check() {
    if workspace.frontmostApplication?.processIdentifier != foreground {
        violations.insert("foreground_changed")
    }
    if order() != baseline { violations.insert("window_order_changed") }
    if CGEvent(source: nil)!.location != pointer { violations.insert("pointer_moved") }
}
let token = workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
    let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    if app?.processIdentifier != foreground { violations.insert("foreground_changed") }
}
try Data("ready".utf8).write(to: URL(fileURLWithPath: ready))
let deadline = Date().addingTimeInterval(30)
while !FileManager.default.fileExists(atPath: stop) && Date() < deadline {
    check()
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
check()
if Date() >= deadline { violations.insert("witness_timeout") }
workspace.notificationCenter.removeObserver(token)
let result: [String: Any] = ["violations": violations.sorted(), "sampleIntervalMs": 10]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
exit(violations.isEmpty ? 0 : 1)

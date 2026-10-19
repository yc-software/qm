#![cfg(target_os = "macos")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn serve_exits_on_sigterm_with_stdin_still_open() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_desk")).arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "invalid JSON").unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert!(line.contains("bad_request"), "{line}");
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{status}");
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("serve did not exit after SIGTERM while stdin remained open");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(input);
}

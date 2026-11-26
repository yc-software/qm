use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn a_reply_holding_line_separators_reaches_a_line_reader_whole() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_desk")).arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    writeln!(child.stdin.take().unwrap(), "{{\"id\":7,\"cmd\":{{\"type\":\"a\u{2028}b\u{2029}c\"}}}}").unwrap();
    let output = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
    let lines: Vec<&str> = output.split(['\n', '\u{2028}', '\u{2029}']).filter(|line| !line.is_empty()).collect();
    assert_eq!(lines.len(), 1, "{output:?}");
    let reply: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert!(reply["reply"]["message"].as_str().unwrap().contains("a\u{2028}b\u{2029}c"), "{reply}");
}

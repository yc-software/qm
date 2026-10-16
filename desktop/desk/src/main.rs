mod protocol;

#[cfg(target_os = "macos")]
mod mac;

#[cfg(not(target_os = "macos"))]
mod mac {
    use crate::protocol::{Command, ErrorCode, Failure, Point, Reply};
    #[derive(Default)]
    pub struct Desk(());
    impl Desk {
        pub fn handle(&mut self, _: Command, _: &mut dyn FnMut(u32, Point) -> Result<(), Failure>) -> Reply {
            Reply::Error(Failure::new(ErrorCode::UnsupportedPlatform, "desk only drives macOS"))
        }
    }
}

use base64::Engine;
use protocol::*;
use std::io::{BufRead, Write};

const USAGE: &str = "usage:
  desk permissions [--prompt]
  desk apps
  desk observe <app> [--png out.png]
  desk act <app> '<actions json>' [--png out.png]
  desk serve            JSON lines on stdin/stdout (see PROTOCOL.md)";

fn main() {
    if let Err(e) = run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let mut desk = mac::Desk::default();
    let arg = |i: usize| args.get(i).cloned().ok_or_else(|| USAGE.to_string());
    let png = args.iter().position(|a| a == "--png").and_then(|i| args.get(i + 1).cloned());
    let cmd = match args.first().map(String::as_str) {
        Some("serve") => return serve(&mut desk),
        Some("permissions") => Command::Permissions { prompt: args.iter().any(|a| a == "--prompt") },
        Some("apps") => Command::Apps,
        Some("observe") => Command::Observe { app: arg(1)?, screenshot: png.is_some(), diff: false },
        Some("act") => Command::Act {
            app: arg(1)?,
            actions: serde_json::from_str(&arg(2)?).map_err(|e| format!("bad actions json: {e}"))?,
            observe: true,
            screenshot: png.is_some(),
            pace: false,
            diff: false,
        },
        _ => return Err(USAGE.into()),
    };
    if let Command::Act { app, .. } = &cmd {
        if let Reply::Error(error) = desk.handle(Command::Observe { app: app.clone(), screenshot: false, diff: false }, &mut |_, _| Ok(()))
        {
            return print(Reply::Error(error), None);
        }
    }
    print(desk.handle(cmd, &mut |_, _| Ok(())), png.as_deref())
}

fn show(o: &Observation, png: Option<&str>) -> Result<(), String> {
    let cut = if o.truncated { " (truncated)" } else { "" };
    let f = o.frame;
    println!("{} \"{}\" pid {} @{:.0},{:.0} {:.0}x{:.0}, {} elements{cut}", o.app, o.window, o.pid, f.x, f.y, f.w, f.h, o.elements);
    print!("{}", o.tree);
    if let (Some(s), Some(path)) = (&o.screenshot, png) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&s.png_base64).map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
        println!("screenshot {}x{} ({} px per point) -> {path}", s.width, s.height, s.pixels_per_point);
    }
    Ok(())
}

fn print(reply: Reply, png: Option<&str>) -> Result<(), String> {
    match &reply {
        Reply::Observation(o) => show(o, png),
        Reply::Acted { completed, failure, observation, observation_failure } => {
            println!("completed {completed} action(s)");
            if let Some(f) = failure {
                println!("action {} failed: {:?}: {}", f.action.unwrap_or(0), f.code, f.message);
            }
            if let Some(f) = observation_failure {
                println!("observation failed after actions: {:?}: {}", f.code, f.message);
            }
            observation.as_ref().map_or(Ok(()), |o| show(o, png))
        }
        Reply::Apps { apps } => {
            for a in apps {
                let active = if a.active { " (active)" } else { "" };
                println!("{:<28} {:<40} pid {:<6}{active}", a.name, a.bundle_id.as_deref().unwrap_or("-"), a.pid);
            }
            Ok(())
        }
        Reply::Permissions { .. } => serde_json::to_string_pretty(&reply).map(|s| println!("{s}")).map_err(|e| e.to_string()),
        Reply::Error(f) => Err(format!("{:?}: {}", f.code, f.message)),
        Reply::Pointer { .. } => Ok(()),
    }
}

fn serve(desk: &mut mac::Desk) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    let mut lines = std::io::stdin().lock().lines();
    while let Some(line) = lines.next() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Request>(&line) {
            Ok(r) => {
                let id = r.id;
                let reply = desk.handle(r.cmd, &mut |action, point| {
                    send(&mut out, &Response { id, reply: Reply::Pointer { action, point } })
                        .map_err(|e| Failure::new(ErrorCode::ActionFailed, e))?;
                    arrived(&mut lines, id)
                });
                Response { id, reply }
            }
            Err(e) => Response { id: 0, reply: Reply::Error(Failure::new(ErrorCode::BadRequest, e.to_string())) },
        };
        send(&mut out, &resp)?;
    }
    Ok(())
}

fn send(out: &mut impl Write, resp: &Response) -> Result<(), String> {
    let s = serde_json::to_string(resp).map_err(|e| e.to_string())?;
    writeln!(out, "{s}").and_then(|_| out.flush()).map_err(|e| e.to_string())
}

fn arrived(lines: &mut impl Iterator<Item = std::io::Result<String>>, id: u64) -> Result<(), Failure> {
    let line = lines.next().and_then(Result::ok).unwrap_or_default();
    match serde_json::from_str::<Request>(&line) {
        Ok(Request { id: got, cmd: Command::Arrived }) if got == id => Ok(()),
        _ => Err(Failure::new(ErrorCode::BadRequest, format!("expected arrived for request {id}"))),
    }
}

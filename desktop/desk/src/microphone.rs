use crate::cancellation;
use block2::RcBlock;
use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};
use objc2_core_audio::{
    kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioProcessPropertyBundleID, kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyPID, AudioObjectAddPropertyListenerBlock,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::c_void;
use std::io::Write;
use std::ptr::{null, NonNull};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct InputApp {
    bundle_id: Option<String>,
    pid: i32,
}

#[derive(Serialize)]
struct Line<'a> {
    r#type: &'static str,
    apps: &'a [InputApp],
}

const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;

fn address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain }
}

fn read<T>(object: AudioObjectID, selector: u32, mut value: T) -> Option<T> {
    let mut size = size_of::<T>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&address(selector)),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::from(&mut value).cast(),
        )
    };
    (status == 0).then_some(value)
}

fn processes() -> Result<Vec<AudioObjectID>, String> {
    let list = address(kAudioHardwarePropertyProcessObjectList);
    let unavailable =
        |status| format!("CoreAudio could not list audio processes (OSStatus {status}); meeting detection needs macOS 14.2 or later");
    let mut size = 0u32;
    let status = unsafe { AudioObjectGetPropertyDataSize(SYSTEM, NonNull::from(&list), 0, null(), NonNull::from(&mut size)) };
    if status != 0 {
        return Err(unavailable(status));
    }
    let mut ids: Vec<AudioObjectID> = vec![0; size as usize / size_of::<AudioObjectID>()];
    let status = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM,
            NonNull::from(&list),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::new(ids.as_mut_ptr()).unwrap_or(NonNull::dangling()).cast(),
        )
    };
    if status != 0 {
        return Err(unavailable(status));
    }
    ids.truncate(size as usize / size_of::<AudioObjectID>());
    Ok(ids)
}

fn bundle_id(process: AudioObjectID) -> Option<String> {
    let value = read::<*const c_void>(process, kAudioProcessPropertyBundleID, null())?;
    if value.is_null() {
        return None;
    }
    let id = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) }.to_string();
    (!id.is_empty()).then_some(id)
}

fn census(ids: &[AudioObjectID]) -> Vec<InputApp> {
    let mut apps: Vec<InputApp> = ids
        .iter()
        .filter(|&&id| read(id, kAudioProcessPropertyIsRunningInput, 0u32).is_some_and(|running| running != 0))
        .map(|&id| InputApp { bundle_id: bundle_id(id), pid: read(id, kAudioProcessPropertyPID, 0i32).unwrap_or(0) })
        .collect();
    apps.sort();
    apps
}

pub fn watch() -> Result<(), String> {
    let (tx, rx) = channel();
    let listener: RcBlock<dyn Fn(u32, NonNull<AudioObjectPropertyAddress>)> = RcBlock::new(move |_, _| {
        let _ = tx.send(());
    });
    let listen = |object: AudioObjectID, selector: u32| unsafe {
        AudioObjectAddPropertyListenerBlock(object, NonNull::from(&address(selector)), None, RcBlock::as_ptr(&listener))
    };
    let status = listen(SYSTEM, kAudioHardwarePropertyProcessObjectList);
    if status != 0 {
        return Err(format!("CoreAudio refused a process list listener (OSStatus {status}); meeting detection needs macOS 14.2 or later"));
    }
    let mut watched = HashSet::new();
    let mut last = None;
    let mut out = std::io::stdout().lock();
    while !cancellation::cancelled() {
        let ids = processes()?;
        watched.retain(|id| ids.contains(id));
        for &id in &ids {
            if !watched.contains(&id) && listen(id, kAudioProcessPropertyIsRunningInput) == 0 {
                watched.insert(id);
            }
        }
        let apps = census(&ids);
        if last.as_ref() != Some(&apps) {
            let line = serde_json::to_string(&Line { r#type: "microphone", apps: &apps }).map_err(|e| e.to_string())?;
            writeln!(out, "{line}").and_then(|_| out.flush()).map_err(|e| e.to_string())?;
            last = Some(apps);
        }
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(()) => break,
                Err(RecvTimeoutError::Timeout) if !cancellation::cancelled() => {}
                Err(_) => return Ok(()),
            }
        }
    }
    Ok(())
}

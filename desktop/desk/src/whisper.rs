use base64::Engine;
use serde::Deserialize;
use std::io::{BufRead, Write};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperVadContext, WhisperVadContextParams,
    WhisperVadParams,
};

const SHORTEST: usize = 17_600;
const SAMPLES_PER_CENTISECOND: f32 = 160.0;
const GAP: usize = 1_600;

#[derive(Deserialize)]
struct Segment {
    pcm: String,
    #[serde(default)]
    prompt: String,
}

pub fn serve(model: &str, vad: &str) -> Result<(), String> {
    whisper_rs::install_logging_hooks();
    let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
        .map_err(|e| format!("could not load the transcription model: {e}"))?;
    let mut state = context.create_state().map_err(|e| format!("could not start transcription: {e}"))?;
    let mut vad =
        WhisperVadContext::new(vad, WhisperVadContextParams::new()).map_err(|e| format!("could not load the voice activity model: {e}"))?;
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let reply = match transcribe(&mut state, &mut vad, &line.map_err(|e| e.to_string())?) {
            Ok(text) => serde_json::json!({ "text": text }),
            Err(error) => serde_json::json!({ "error": error }),
        };
        writeln!(out, "{reply}").and_then(|()| out.flush()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn transcribe(state: &mut WhisperState, vad: &mut WhisperVadContext, line: &str) -> Result<String, String> {
    let segment: Segment = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(segment.pcm).map_err(|e| e.to_string())?;
    let audio: Vec<f32> = bytes.as_chunks().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
    if audio.is_empty() {
        return Err("the segment had no audio".into());
    }
    let sample = |centiseconds: f32| ((centiseconds * SAMPLES_PER_CENTISECOND) as usize).min(audio.len());
    let mut audio: Vec<f32> = vad
        .segments_from_samples(WhisperVadParams::new(), &audio)
        .map_err(|e| format!("voice activity detection failed: {e}"))?
        .flat_map(|speech| audio[sample(speech.start)..sample(speech.end)].iter().copied().chain(std::iter::repeat_n(0.0, GAP)))
        .collect();
    if audio.is_empty() {
        return Ok(String::new());
    }
    audio.resize(audio.len().max(SHORTEST), 0.0);
    let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
    params.set_language(Some("auto"));
    params.set_initial_prompt(&segment.prompt.replace('\0', ""));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    state.full(params, &audio).map_err(|e| format!("transcription failed: {e}"))?;
    let text: Vec<String> = state.as_iter().map(|s| s.to_string()).collect();
    Ok(text.concat().trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_model_is_reported() {
        assert!(serve("/nonexistent/model.bin", "/nonexistent/vad.bin").unwrap_err().contains("could not load the transcription model"));
    }
}

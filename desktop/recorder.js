{
  const { recorderHost: host, createSegmenter } = window;
  const loudness = 0.015;
  const tracks = [];
  const local = host.local();
  const encode = async (blob) => {
    if (!(await local)) return new Uint8Array(await blob.arrayBuffer());
    try {
      const audio = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(await blob.arrayBuffer());
      return new Uint8Array(Float32Array.from(audio.getChannelData(0)).buffer);
    } catch (error) {
      return `${error.name}: ${error.message}`;
    }
  };

  async function capture(speaker, open) {
    let stream;
    try {
      stream = await open();
    } catch (error) {
      host.track(speaker, `${error.name}: ${error.message}`);
      return;
    }
    for (const video of stream.getVideoTracks()) video.stop();
    const input = stream.getAudioTracks()[0];
    if (!input) {
      host.track(speaker, "No audio track was provided");
      return;
    }
    const audio = new MediaStream([input]);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(audio).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const cut = createSegmenter(Date.now());
    let sent = Promise.resolve();
    const begin = () => {
      const chunks = [];
      const recorder = new MediaRecorder(audio, { mimeType: "audio/webm;codecs=opus" });
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.start();
      return { recorder, chunks };
    };
    const finish = ({ recorder, chunks }, segment) => {
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.stop();
      sent = sent.then(async () => {
        await stopped;
        if (segment.speech) await host.segment(speaker, segment.at, await encode(new Blob(chunks)));
      });
    };
    let current = begin();
    input.onended = () => host.track(speaker, "The audio source stopped");
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      const segment = cut(Date.now(), level > loudness);
      if (!segment) return;
      finish(current, segment);
      current = begin();
    }, 100);
    tracks.push(async () => {
      clearInterval(timer);
      finish(current, cut(Date.now(), false, true));
      input.onended = null;
      input.stop();
      await sent;
      await context.close();
    });
  }

  const started = Promise.all([
    capture("me", () =>
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
    ),
    capture("others", () => navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })),
  ]);
  host.onStop(async () => {
    await started;
    await Promise.all(tracks.map((stop) => stop()));
    host.done();
  });
}

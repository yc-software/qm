window.createSegmenter = (start) => {
  const shortest = 10_000;
  const longest = 30_000;
  const pause = 800;
  const speechFrames = 3;
  let begun = start;
  let lastLoud = start;
  let loudFrames = 0;
  return (now, loud, end = false) => {
    if (loud) {
      loudFrames++;
      lastLoud = now;
    }
    const length = now - begun;
    if (!end && length < longest && (length < shortest || now - lastLoud < pause)) return undefined;
    const segment = { at: begun, speech: loudFrames >= speechFrames };
    begun = now;
    lastLoud = now;
    loudFrames = 0;
    return segment;
  };
};

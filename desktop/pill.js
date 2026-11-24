{
  const { pillHost: host } = window;
  const pill = document.getElementById("pill");
  const time = document.getElementById("time");
  const line = document.getElementById("line");
  const bars = Array.from({ length: 14 }, () => document.createElement("i"));
  document.getElementById("wave").append(...bars);
  const levels = { me: 0, others: 0 };
  const heights = bars.map(() => 3);
  let state;

  const tick = () => {
    if (!state) return;
    const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  setInterval(tick, 1000);
  setInterval(() => {
    const level = state?.stopping ? 0 : Math.max(levels.me, levels.others);
    heights.shift();
    heights.push(3 + 15 * Math.min(1, Math.sqrt(level * 10)));
    bars.forEach((bar, index) => (bar.style.height = `${heights[index]}px`));
  }, 100);

  host.onLevel((speaker, level) => (levels[speaker] = level));
  host.onState((next) => {
    state = next;
    pill.classList.toggle("stopping", state.stopping);
    line.classList.toggle("problem", !state.stopping && Boolean(state.problem));
    line.textContent = state.stopping ? "Saving…" : state.problem || state.line || "Listening…";
    tick();
  });
  pill.addEventListener("click", () => host.open());
  document.getElementById("stop").addEventListener("click", (event) => {
    event.stopPropagation();
    host.stop();
  });
}

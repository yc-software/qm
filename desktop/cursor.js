const cursor = document.getElementById("cursor");
const pulse = document.getElementById("pulse");
const stiffness = 190;
const damping = 2 * Math.sqrt(stiffness) * 0.72;
let flight = 0;
let current;
let resting;

function place([x, y]) {
  cursor.style.translate = `${x - 2}px ${y - 2}px`;
  current = [x, y];
}

function arc(from, to) {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const distance = Math.hypot(dx, dy);
  if (distance < 140) return (s) => [from[0] + dx * s, from[1] + dy * s];
  const bend = Math.min(distance * 0.22, 160) * (dx >= 0 ? -1 : 1);
  const control = [(from[0] + to[0]) / 2 - (dy / distance) * bend, (from[1] + to[1]) / 2 + (dx / distance) * bend];
  return (s) => [0, 1].map((i) => (1 - s) ** 2 * from[i] + 2 * (1 - s) * s * control[i] + s ** 2 * to[i]);
}

function land(to) {
  pulse.style.translate = `${to[0]}px ${to[1]}px`;
  pulse.animate(
    [
      { scale: 0.3, opacity: 0.7 },
      { scale: 1.6, opacity: 0 },
    ],
    { duration: 380, easing: "ease-out" },
  );
  cursor.animate([{ scale: "1 1" }, { scale: "1.16 0.84" }, { scale: "0.94 1.06" }, { scale: "1 1" }], {
    duration: 260,
    easing: "ease-out",
  });
  resting = setTimeout(() => {
    cursor.classList.remove("shown");
    current = undefined;
  }, 2000);
}

window.fly = (from, to) =>
  new Promise((resolve) => {
    const id = ++flight;
    clearTimeout(resting);
    const path = arc(current ?? from, to);
    let [s, v, last] = [0, 0, performance.now()];
    place(path(0));
    cursor.classList.add("shown");
    const frame = (now) => {
      if (id !== flight) return resolve();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      v += (stiffness * (1 - s) - damping * v) * dt;
      s += v * dt;
      if (Math.abs(1 - s) < 0.003 && Math.abs(v) < 0.05) {
        place(to);
        land(to);
        return setTimeout(resolve, 90);
      }
      place(path(s));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

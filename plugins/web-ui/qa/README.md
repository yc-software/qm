# Web UI QA recordings

Scripts for recording web UI flows in a real browser, replaying the recorded API traffic without a backend, and making before/after videos of a change. They need Node 24, ffmpeg, and Chromium for Playwright:

```sh
npm --prefix plugins/web-ui ci
npx --prefix plugins/web-ui playwright install --with-deps chromium
```

## Record a flow

```sh
node plugins/web-ui/qa/record-flow.mjs --url http://localhost:<port>/ --flow plugins/web-ui/qa/flows/chat.mjs --out /tmp/qa --label live --fixtures /tmp/qa/fixtures.json
```

It writes `<label>.mp4` with Playwright's action annotations and a caption for each step, one screenshot per step, and `<label>-report.json` listing failed steps, page errors, failed or 5xx requests, and fixture capture errors. It exits 1 when any step fails. Point it at a dev instance (`npm run dev-instance:web`) through `localhost`; core rejects `127.0.0.1` as a different origin.

A flow is an ES module whose default export receives `{ page, step }`. `page` is the Playwright page, and each `step(name, fn)` becomes a caption, a screenshot, and a report row. `flows/chat.mjs` sends a prompt, waits for the reply, and reloads; `PROMPT` and `EXPECT` override the prompt and the text the reply must contain.

`--fixtures` saves every API and JSON response, and every `fetch()` event stream with the timing of each chunk; `EventSource` streams are saved empty and listed under capture errors. Fixtures hold exactly what the browser received, so record against a dev instance with synthetic data.

## Replay without a backend

```sh
npm --prefix plugins/web-ui run build
node plugins/web-ui/qa/mock-core.mjs --dist plugins/web-ui/dist-web --fixtures /tmp/qa/fixtures.json --port 8899
```

`mock-core` serves the built UI with `vite preview` and answers each request with the recorded response for the same method, path, and query. Repeated calls replay in recorded order and then repeat the last response. IDs the UI generates during replay, such as a new conversation's thread ID, are mapped to the recorded IDs in the same position and mapped back in responses, so a flow that starts a conversation and reloads replays the recorded one. Event streams replay at their recorded pace. Requests with no fixture are logged as `MISS`; reads get a 404 and writes an empty 200. `bug-video.sh` prints each side's `MISS` lines.

## Before/after video

```sh
plugins/web-ui/qa/bug-video.sh <before-ref> <after-ref> plugins/web-ui/qa/flows/chat.mjs /tmp/qa/fixtures.json /tmp/qa/compare
```

It builds the web UI at both refs, replays the same fixtures against each build, records the flow on both, and writes `before-after.mp4` with the two recordings side by side. It exits 1 and names the report when either side's flow fails, which is expected for the before side when the flow checks for the fix. The builds reuse the current `plugins/web-ui/node_modules`. For backend changes, record the flow against two dev instances and combine them with `side-by-side.sh before.mp4 after.mp4 out.mp4 [before-label] [after-label]`.

Keep recordings and fixtures out of the repository.

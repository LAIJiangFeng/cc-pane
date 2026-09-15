// Windows DEV WebView2 only. No release restart, terminal text export or screenshot.
// node scripts/dev-terminal-input-probe.mjs install|snapshot|stop|watch [port] [output-directory]
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const action = process.argv[2] ?? "snapshot";
const port = Number(process.argv[3] ?? 9223);
const output = process.argv[4] ? resolve(process.argv[4]) : null;
if (!["install", "snapshot", "stop", "watch"].includes(action)) throw new Error("Unknown probe action");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CDP port");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const target = targets.find(item => item.type === "page" && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(item.url));
if (!target) throw new Error("A local DEV page is required");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
let disconnected = false;
ws.onclose = () => {
  disconnected = true;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("DEV disconnected")); }
  pending.clear();
};
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id); clearTimeout(item.timer);
  message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
};
const evaluate = expression => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("DEV evaluation timed out")); }, 15_000);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
}).then(result => {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "DEV evaluation failed");
  return result.result.value;
});

// DEV inspection only: locate public xterm objects in React refs without reading
// hooks' strings, terminal buffers, input values or props containing user data.
const install = `(async () => {
  if (!window.__TAURI_INTERNALS__) throw new Error('A Tauri DEV page is required');
  const { installTerminalInputProbe } = await import('/web/dev/terminalInputProbe.ts');
  const terminals = new Set();
  for (const host of document.querySelectorAll('.cc-terminal-host')) {
    const key = Object.keys(host).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && host[key];
    for (let level = 0; fiber && level < 80; level++, fiber = fiber.return) {
      for (let hook = fiber.memoizedState, i = 0; hook && i < 180; hook = hook.next, i++) {
        const value = hook.memoizedState?.current;
        if (value && typeof value.onData === 'function' && typeof value.onWriteParsed === 'function'
            && value.textarea instanceof HTMLTextAreaElement && host.contains(value.textarea)) terminals.add(value);
      }
    }
  }
  window.__ccPanesInputProbe?.stop();
  window.__ccPanesInputProbe = installTerminalInputProbe({ terminals: [...terminals] });
  return window.__ccPanesInputProbe.snapshot();
})()`;

try {
  if (output) await mkdir(output, { recursive: true });
  let snapshot;
  if (action === "install" || action === "watch") snapshot = await evaluate(install);
  else {
    if (action === "stop") await evaluate("window.__ccPanesInputProbe?.stop()");
    snapshot = await evaluate("window.__ccPanesInputProbe?.snapshot() ?? null");
  }
  if (!snapshot) throw new Error("Input probe is not installed");
  const persist = async value => {
    if (output) await writeFile(join(output, "input-latest.json"), JSON.stringify(value, null, 2));
  };
  await persist(snapshot);
  console.log(JSON.stringify({ action, active: snapshot.active, observedTerminals: snapshot.observedTerminals, output }));
  if (action === "watch") {
    for (let i = 0; i < 121 && snapshot.active; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      if (disconnected) break;
      try { snapshot = await evaluate("window.__ccPanesInputProbe?.snapshot() ?? null"); }
      catch (error) { if (disconnected) break; throw error; }
      if (!snapshot) break;
      await persist(snapshot);
    }
    if (disconnected && output && snapshot) await writeFile(join(output, "input-latest.json"),
      JSON.stringify({ ...snapshot, collectionEndedAt: new Date().toISOString(), collectionEndReason: "DEV disconnected" }, null, 2));
  } else if (action === "snapshot") console.log(JSON.stringify(snapshot, null, 2));
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  // Closing this transport detaches CDP; it never sends Browser.close.
  ws.close();
}

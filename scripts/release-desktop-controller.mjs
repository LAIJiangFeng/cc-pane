// Interactive acceptance harness for a copied, isolated Windows release build.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

assert.equal(process.platform, 'win32');
const [playwrightPath, programArg, evidenceArg, flavor = 'candidate'] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const program = resolve(programArg), evidence = resolve(evidenceArg);
const root = await mkdtemp(join(evidence, `${flavor}-desktop-`));
const profile = join(root, 'profile'), project = join(root, 'project');
await mkdir(join(profile, 'skills'), { recursive: true });
await mkdir(project);
await writeFile(join(profile, 'skills', 'legacy-global-skill-cleanup-v1.json'), JSON.stringify({ removed: [], preserved: [], failed: [], scope: 'isolated-test' }));
const settings = (await readFile('scripts/fixtures/v13-acceptance.toml', 'utf8'))
  .replace('scrollback = 20000', 'scrollback = 5000')
  .replace('shell = "powershell"', 'shell = "cmd"')
  .replace('[wallpaper]\nenabled = true', '[wallpaper]\nenabled = false')
  .replace('onWaitingInput = false', 'onWaitingInput = true');
await writeFile(join(profile, 'config.toml'), settings + '\n[quickTerminal]\nenabled = true\nshortcut = "Ctrl+Alt+Shift+F11"\nautoHideOnBlur = false\nheightFraction = 0.4\n');
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
const debugPort = await freePort(), apiPort = await freePort();
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('CC_PANES_')) delete env[key];
Object.assign(env, { CC_PANES_WORKSPACE_NAME: 'ccpane-workspace', CCPANES_CONFIG_DIR: profile,
  CCPANES_DAEMON_DATA_DIR: profile, CCPANES_TERMINAL_DAEMON: '1',
  CCPANES_TERMINAL_DAEMON_BIN: join(program, 'binaries', 'cc-panes-daemon.exe'),
  CC_PANES_ORCHESTRATOR_PORT: String(apiPort), WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}` });
const executable = join(program, 'cc-panes.exe');
const app = spawn(executable, [], { cwd: program, env, stdio: ['ignore', 'pipe', 'pipe'] });
const appLog = createWriteStream(join(root, 'app.log')); app.stdout.pipe(appLog); app.stderr.pipe(appLog);
const wait = ms => new Promise(done => setTimeout(done, ms));
const until = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.equal(app.exitCode, null, `acceptance app exited before ${label}`);
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(`timeout: ${label}`);
};
let browser, page, daemon, owner, projectId;
const sessions = [], checks = {}, errors = [];
const redact = value => String(value).replaceAll(daemon?.token ?? '__none__', '[REDACTED]');
const call = (command, args = {}) => page.evaluate(([name, args]) => window.__TAURI_INTERNALS__.invoke(name, args), [command, args]);
async function request(path, method = 'GET', body) {
  const response = await fetch(`http://${daemon.addr}${path}`, { method, headers: {
    Authorization: `Bearer ${daemon.token}`, 'X-CC-Panes-Instance': owner, 'Content-Type': 'application/json',
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function addPane(title, { wsl = false, layout = 'CCP-ACCEPT', parentSessionId } = {}) {
  const tabId = randomUUID(), paneId = randomUUID(), launchId = randomUUID();
  const remotePath = `/mnt/${project[0].toLowerCase()}/${project.slice(3).replaceAll('\\', '/')}`;
  const wslInfo = wsl ? { distro: 'Ubuntu', remotePath } : undefined;
  const id = await call('create_terminal_session', { request: { projectPath: project,
    workspaceName: 'ccpane-workspace', cols: 120, rows: 40, cliTool: 'none', skipMcp: true,
    launchId, originTabId: tabId, originTerminalPaneId: paneId, ...(wsl ? { wsl: wslInfo } : {}) } });
  sessions.push(id);
  await call('plugin:event|emit', { event: 'orchestrator-launch-task', payload: {
    taskId: launchId, projectId, projectPath: project, workspaceName: 'ccpane-workspace',
    sessionId: id, tabId, terminalPaneId: paneId, cliTool: 'none', layoutName: layout,
    title, placement: 'beside', ...(parentSessionId ? { parentSessionId } : {}), ...(wsl ? { wsl: wslInfo } : {}),
  } });
  return id;
}
const output = async id => (await request(`/api/sessions/${id}/output?lines=100`)).lines.join('\n');
const input = (id, data) => call('write_terminal', { sessionId: id, data });
const git = args => execFileSync('git.exe', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
async function save() {
  await writeFile(join(root, 'results.json'), JSON.stringify({ root, flavor, appPid: app.pid,
    daemonPid: daemon?.pid, debugPort, sessions, checks, errors }, null, 2));
}
async function close() {
  for (const id of sessions) { try { await request(`/api/sessions/${id}`, 'DELETE'); } catch {} }
  if (daemon) { try { await request('/api/daemon/shutdown', 'POST'); } catch {} }
  await Promise.race([browser?.close().catch(() => {}), wait(3000)]);
  app.kill(); appLog.end();
}

try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; } }, 'WebView2', 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  await until(async () => { page = browser.contexts().flatMap(context => context.pages()).find(p => /tauri|localhost|127\.0\.0\.1/.test(p.url()) && !p.url().includes('mode=popup')); return Boolean(page); }, 'main page');
  await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  page.on('pageerror', error => errors.push(redact(error.message)));
  await until(async () => { try { daemon = JSON.parse(await readFile(join(profile, 'runtime', 'daemon-manifest.json'), 'utf8')); return true; } catch { return false; } }, 'daemon manifest');
  owner = (await call('get_terminal_daemon_client_info')).instanceId;
  checks.daemonHash = createHash('sha256').update(await readFile(join(program, 'binaries', 'cc-panes-daemon.exe'))).digest('hex');
  const status = await request('/api/daemon/status');
  if (flavor === 'candidate') assert.equal(status.binarySha256, checks.daemonHash);
  checks.orchestrator = await call('get_orchestrator_status');
  assert.equal(checks.orchestrator.lifecycle, 'ready');
  await call('create_workspace', { name: 'ccpane-workspace', path: project });
  projectId = (await call('add_project', { path: project })).id;
  await page.evaluate(() => localStorage.setItem('cc-panes-layout-ui', JSON.stringify({ state: { switcherMode: 'topbar', layoutBarDensity: 'compact' }, version: 0 })));
  await page.reload(); await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  await wait(1500); await save();
  console.log(JSON.stringify({ ready: true, root, appPid: app.pid, debugPort }));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const operation = JSON.parse(line);
      if (operation.op === 'close') { await save(); break; }
      // Trusted local harness input only, analogous to a Playwright evaluate call.
      const execute = new AsyncFunction('ctx', operation.code);
      const value = await execute({ page, browser, call, request, addPane, output, input, wait,
        until, git, readFile, writeFile, project, profile, root, sessions, checks, errors, save });
      await save(); console.log(JSON.stringify({ id: operation.id, ok: true, value }));
    } catch (error) { await save(); console.log(JSON.stringify({ ok: false, error: redact(error.stack) })); }
  }
} catch (error) {
  errors.push(redact(error.stack)); await save(); console.error(redact(error.stack)); process.exitCode = 1;
} finally { await close(); process.stdin.destroy(); }

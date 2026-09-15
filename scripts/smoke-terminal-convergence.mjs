// Isolated Windows/WebView2 + daemon + WSL acceptance. Never opens user worktrees or resumes user tasks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, stat, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32');
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const sourceExe = resolve(process.argv[3]);
const minutes = Number(process.argv[4] ?? 30);
const cycles = Number(process.argv[5] ?? 100);
assert.ok(minutes > 0 && minutes <= 60 && cycles >= 0 && cycles <= 100);
const evidence = resolve(process.env.CCPANES_CONVERGENCE_EVIDENCE ?? '../cc-book-target/convergence-evidence');
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(evidence, 'native-'));
const program = join(root, 'program'), profile = join(root, 'profile'), project = join(root, 'project');
await Promise.all([program, join(program, 'binaries'), profile, project, join(profile, 'wallpapers')].map(p => mkdir(p, {recursive:true})));
const executable = join(program, 'cc-panes.exe');
await copyFile(sourceExe, executable);
const binaryHashes = {};
for (const name of ['cc-panes-daemon','cc-panes-cli-hook','cc-panes-ctl','cc-panes-web']) {
  const source = join(dirname(sourceExe), `${name}.exe`), target = join(program, 'binaries', `${name}.exe`);
  await copyFile(source, target);
  binaryHashes[name] = createHash('sha256').update(await readFile(target)).digest('hex');
}
await copyFile('src-tauri/icons/128x128.png', join(profile, 'wallpapers', 'terminal-test.png'));
const settings = (await readFile('scripts/fixtures/v13-acceptance.toml','utf8'))
  .replace('kind = "video"','kind = "image"').replace('__WALLPAPER_FILE__','terminal-test.png');
await writeFile(join(profile,'config.toml'),settings);
const fixture = join(project, 'tui.cjs');
await copyFile('scripts/fixtures/terminal-convergence-tui.cjs', fixture);
const wslPath = p => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replaceAll('\\','/')}`;
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const debugPort=await freePort(), apiPort=await freePort();
const env={...process.env,CCPANES_CONFIG_DIR:profile,CCPANES_DAEMON_DATA_DIR:profile,CCPANES_TERMINAL_DAEMON:'1',
  CCPANES_TERMINAL_DAEMON_BIN:join(program,'binaries','cc-panes-daemon.exe'),
  WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),CC_PANES_ORCHESTRATOR_PORT:String(apiPort),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}`};
for(const name of ['CC_PANES_API_TOKEN','CC_PANES_API_BASE_URL','CC_PANES_API_PORT','CC_PANES_PTY_SESSION_ID','CC_PANES_LAUNCH_ID','CC_PANES_DATA_DIR']) delete env[name];
const app=spawn(executable,[],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
const appLog=createWriteStream(join(root,'app.log'));app.stdout.pipe(appLog);app.stderr.pipe(appLog);
let browser,page,daemon,owner,recorderDirectory,projectId;
const sessions=[],latencies=[],errors=[];
const result={root,appPid:app.pid,minutes,cycles,binaryHashes,checks:{},samples:[],latencies,errors};
app.on('exit',(code,signal)=>{result.appExit={code,signal};});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const cleanError=e=>String(e).replaceAll(daemon?.token??'__no_token__','<redacted>');
const save=()=>writeFile(join(root,'results.json'),JSON.stringify(result,null,2));
const until=async(fn,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(result.appExit)throw new Error(`App exited before ${label}: ${JSON.stringify(result.appExit)}`);if(await fn())return;await wait(30);}throw new Error(`Timeout: ${label}`);};
const call=(command,args={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
async function request(path,method='GET',body){
  const response=await fetch(`http://${daemon.addr}${path}`,{method,headers:{Authorization:`Bearer ${daemon.token}`,'Content-Type':'application/json','X-CC-Panes-Instance':owner??'convergence'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error(`daemon ${method} ${path}: ${response.status}`);
  return response.status===204?null:response.json();
}
async function output(id){return (await request(`/api/sessions/${id}/output?lines=200`)).lines.join('');}
async function write(id,data){return call('write_terminal',{sessionId:id,data});}
async function ping(id,text='PING'+randomUUID().slice(0,6)){
  const begin=performance.now();await write(id,text+'\r');
  await until(async()=> (await output(id)).includes('ACK:'+text),'fixture echo',10000);
  return performance.now()-begin;
}
async function processStats(){
  const script=`@(Get-Process -Id ${app.pid},${daemon.pid} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=$_.Id;threads=$_.Threads.Count;handles=$_.HandleCount;privateBytes=$_.PrivateMemorySize64;responding=$_.Responding} }) | ConvertTo-Json -Compress`;
  return new Promise((res,rej)=>{const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',d=>text+=d);child.on('error',rej);child.on('exit',code=>code?rej(new Error('process stats failed')):res(JSON.parse(text)));});
}
async function latestRecord(){
  if(!recorderDirectory)return null;
  const path=join(recorderDirectory,'performance.jsonl');
  try{const size=(await stat(path)).size;const file=await open(path);const bytes=Buffer.alloc(Math.min(size,128*1024));await file.read(bytes,0,bytes.length,size-bytes.length);await file.close();
    for(const line of bytes.toString().split('\n').reverse()){try{const row=JSON.parse(line);if(row.kind==='sample'&&row.appPid===app.pid)return row;}catch{}}}catch{}
  return null;
}
async function selectLayout(name){await page.locator(`[role="tab"][title="${name}"]`).evaluate(el=>el.click());}
async function addPane(index){
  const wsl=index>=6, layoutName=index===7?'CONVERGENCE-HIDDEN':'CONVERGENCE-ACTIVE';
  const tabId=randomUUID(), paneId=randomUUID(), launchId=randomUUID();
  const id=await call('create_terminal_session',{request:{projectPath:project,workspaceName:'ccpane-workspace',cols:120,rows:30,cliTool:'none',skipMcp:true,launchId,originTabId:tabId,originTerminalPaneId:paneId,
    ...(wsl?{wsl:{distro:'Ubuntu',remotePath:wslPath(project)}}:{})}});
  sessions.push(id);
  await call('plugin:event|emit',{event:'orchestrator-launch-task',payload:{taskId:launchId,projectId,projectPath:project,workspaceName:'ccpane-workspace',sessionId:id,tabId,terminalPaneId:paneId,cliTool:'none',layoutName,title:`TEST ${index+1}`,placement:'beside',...(index>0&&index<7?{parentSessionId:sessions[0]}:{})}});
  await write(id,wsl?`node '${wslPath(fixture)}'\n`:`node.exe '${fixture.replaceAll("'","''")}'\r`);
  await until(async()=> (await output(id)).includes('READY'),`TUI ${index}`,30000);
  return id;
}
async function cycleSessions(){
  let completed=0;
  for(let start=0;start<cycles;start+=4){
    await Promise.all(Array.from({length:Math.min(4,cycles-start)},async(_,offset)=>{
      const marker=`CYCLE-${start+offset}-TAIL`;
      const {sessionId:id}=await request('/api/sessions','POST',{projectPath:project,workspaceName:'ccpane-workspace',cols:120,rows:30,cliTool:'none',skipMcp:true,launchId:randomUUID()});
      const socket=new WebSocket(`ws://${daemon.addr}/ws/${id}?token=${encodeURIComponent(daemon.token)}&instanceId=${encodeURIComponent(owner)}`);
      let closed=false, exit=null, received='';
      socket.addEventListener('error',()=>{});
      socket.addEventListener('close',()=>{closed=true;});
      socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.type==='output')received=(received+message.data).slice(-32768);if(message.type==='exit')exit=message;});
      await until(async()=>socket.readyState===WebSocket.OPEN,'cycle output subscription');
      await request(`/api/sessions/${id}/write`,'POST',{data:`Write-Output ('CYCLE-'+'${start+offset}'+'-TAIL'); exit 7\r`});
      let status;
      await until(async()=>{status=await request(`/api/sessions/${id}/status`);return status.status==='exited';},'natural exit',30000);
      await until(async()=>closed,'server closes both socket halves after exit',10000);
      assert.equal(status.exitCode,7);
      assert.equal(exit?.exitCode,7);
      assert.ok(received.includes(marker),'final output precedes exit on the socket');
      assert.ok((await output(id)).includes(marker));
      completed++;
    }));
  }
  result.checks.naturalExitCycles=completed;
}
try{
  console.log(JSON.stringify({phase:'launch',root,appPid:app.pid}));
  await until(async()=>{try{return(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;}catch{return false;}},'WebView2',90000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  await until(async()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/localhost|127\.0\.0\.1|tauri/.test(p.url()));return Boolean(page);},'main page');
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
  page.on('pageerror',error=>errors.push(cleanError(error)));
  await wait(2000);
  await until(async()=>{try{daemon=JSON.parse(await readFile(join(profile,'runtime','daemon-manifest.json'),'utf8'));return true;}catch{return false;}},'daemon');
  owner=(await call('get_terminal_daemon_client_info')).instanceId;
  result.daemonPid=daemon.pid;
  const daemonStatus=await request('/api/daemon/status');
  assert.equal(daemonStatus.binarySha256,binaryHashes['cc-panes-daemon']);
  result.checks.matchedDaemon=true;
  assert.equal((await call('get_settings')).terminal.scrollback,20000);
  result.checks.historySettingPreserved=true;
  recorderDirectory=(await call('get_performance_recorder_status')).directory;
  await call('create_workspace',{name:'ccpane-workspace',path:project});
  projectId=(await call('add_project',{path:project})).id;
  await page.evaluate(()=>localStorage.setItem('cc-panes-layout-ui',JSON.stringify({state:{switcherMode:'topbar',layoutBarDensity:'compact'},version:0})));
  await page.reload();await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);await wait(1000);
  for(let i=0;i<8;i++)await addPane(i);
  await selectLayout('CONVERGENCE-ACTIVE');
  result.checks.windowsAndWslUnicodeEcho=await Promise.all([ping(sessions[0],'中文🙂…'),ping(sessions[6],'中文🙂…')]);
  const typed='UI'+randomUUID().slice(0,6);
  const typedAt=performance.now();
  await page.locator('.cc-terminal-host:visible .xterm-helper-textarea').first().focus();
  await page.keyboard.type(typed);
  await page.keyboard.press('Enter');
  await until(async()=> (await Promise.all(sessions.slice(0,7).map(output))).some(text=>text.includes('ACK:'+typed)),'keyboard frontend queue echo',10000);
  result.checks.frontendKeyboardEchoMs=performance.now()-typedAt;
  result.beforeCycles=await processStats();
  await cycleSessions();
  await wait(2000);result.afterCycles=await processStats();
  await page.screenshot({path:join(root,'before-soak.png')});
  await page.evaluate(()=>{const probe={ticks:0,maxLagMs:0,last:performance.now()};window.__convergence=probe;probe.timer=setInterval(()=>{const now=performance.now();probe.maxLagMs=Math.max(probe.maxLagMs,now-probe.last-50);probe.last=now;probe.ticks++;},50);});
  const start=Date.now(),end=start+minutes*60000;result.soakStartedAt=new Date(start).toISOString();
  console.log(JSON.stringify({phase:'soak',root,minutes,sessions:8,cycles}));
  while(Date.now()<end){
    const began=performance.now();await call('get_all_terminal_status');const ipcMs=performance.now()-began;
    const echoMs=await ping(sessions[result.samples.length%2===0?0:6]);latencies.push(echoMs);
    result.samples.push({elapsedMs:Date.now()-start,ipcMs,echoMs,processes:await processStats(),record:await latestRecord(),ui:await page.evaluate(()=>({ticks:window.__convergence.ticks,maxLagMs:window.__convergence.maxLagMs}))});
    await save();
    if(result.samples.length%12===0)console.log(JSON.stringify({phase:'soak-progress',root,elapsedSeconds:Math.round((Date.now()-start)/1000),samples:result.samples.length}));
    await wait(5000);
  }
  result.soakElapsedMs=Date.now()-start;
  await selectLayout('CONVERGENCE-HIDDEN');
  result.checks.hiddenWakeEchoMs=await ping(sessions[7],'WAKE');
  await page.screenshot({path:join(root,'after-wake.png')});
  result.afterSoak=await processStats();
  const flows=await Promise.all(sessions.map(id=>request(`/api/sessions/${id}/output-flow`)));
  result.checks.readersAlive=flows.every(flow=>flow?.readerAlive===true);
  result.flows=flows;
  assert.ok(result.checks.readersAlive);
  const sorted=[...latencies].sort((a,b)=>a-b);result.echoP95Ms=sorted[Math.ceil(sorted.length*.95)-1];
  assert.equal(errors.length,0);
  assert.ok(result.soakElapsedMs>=minutes*60000);
  result.passed=true;await save();console.log(JSON.stringify({phase:'passed',root,echoP95Ms:result.echoP95Ms}));
}catch(error){result.error=cleanError(error);result.passed=false;await save();console.error(JSON.stringify({phase:'failed',root,error:result.error}));process.exitCode=1;}
finally{
  if(daemon){for(const id of sessions){try{await request(`/api/sessions/${id}`,'DELETE');}catch{}}}
  await browser?.close().catch(()=>{});
  if(daemon){try{await request('/api/daemon/shutdown','POST');}catch{}}
  app.kill();
  // Restrict emergency cleanup to this run's copied daemon executable.
  if(daemon){const target=join(program,'binaries','cc-panes-daemon.exe').replaceAll("'","''");const script=`$p=Get-Process -Id ${daemon.pid} -ErrorAction SilentlyContinue; if($p -and $p.Path -eq '${target}') { Stop-Process -Id $p.Id -Force }`;
    await new Promise(resolve=>spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'ignore'}).on('exit',resolve));}
  appLog.end();
}

// Controlled TUI fixture: redraw, Unicode, colors, input echoes, and a clean exit.
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let pending = '', acknowledgement = 'READY', frame = 0;
process.stdout.write('\x1b]2;处理中…\x07');
process.stdin.on('data', data => {
  if (data.includes('\x03')) process.exit(0);
  pending += data;
  let boundary;
  while ((boundary = pending.search(/[\r\n]/)) >= 0) {
    const command = pending.slice(0, boundary);
    pending = pending.slice(boundary + 1);
    if (command === 'QUIT') { process.stdout.write('\r\nFINAL-OUTPUT\r\n'); process.exit(7); }
    if (command) acknowledgement = `ACK:${command}`;
  }
});
setInterval(() => {
  const cols = Math.min(90, Math.max(2, process.stdout.columns || 80));
  const rows = Math.min(6, Math.max(1, (process.stdout.rows || 24) - 1));
  const color = frame++;
  const line = `\x1b[38;2;${color%256};${Math.floor(color/256)%256};180m${Array.from('中文🙂 '.repeat(30)).slice(0, Math.max(1,Math.floor(cols/2))).join('')}\x1b[0m`;
  process.stdout.write(`\x1b[H${acknowledgement}\x1b[K\r\n${Array(rows).fill(line).join('\r\n')}\x1b[K`);
}, 50);

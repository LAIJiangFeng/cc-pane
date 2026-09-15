// Deterministic TUI for real PTY recovery and manual IME acceptance.
// Deliberately does not redraw on resize: replay must restore the saved screen.
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.resume();
const rows = Math.max(25, process.stdout.rows || 40);
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l');
for (let row = 1; row <= rows; row++) {
  process.stdout.write(`\x1b[${row};1HROW_${String(row).padStart(2, '0')} 中文恢复验收`);
}
process.stdout.write(`\x1b[${rows};1HREADY_STATIC rows=${rows}\x1b[K`);
process.stdin.on('data', data => {
  if (data.includes('\x03')) { process.stdout.write('\x1b[?1049l'); process.exit(0); }
  process.stdout.write(data);
});

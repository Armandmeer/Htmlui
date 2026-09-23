const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const stageDir = path.resolve(process.argv[2]);
const appDir = path.resolve(process.argv[3] || __dirname);
const port = Number(process.argv[4] || 3010);
const packageChanged = process.argv[5] === '1';
const statusFile = path.join(appDir, 'github-update-status.json');
const protectedNames = new Set(['node_modules', '.git', 'smarthome_state.json', 'smarthome_state.before-update.json', 'github_update.json', 'github-update-status.json']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function writeStatus(state, extra = {}) {
  try { fs.writeFileSync(statusFile, JSON.stringify({ state, ...extra, updatedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
}
function portOpen(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = v => { if (!done) { done = true; try { s.destroy(); } catch (_) {} resolve(v); } };
    s.setTimeout(700, () => finish(false));
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
  });
}
async function waitPortFree(deadlineMs = 30000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) { if (!(await portOpen(port))) return true; await sleep(300); }
  return false;
}
function copyTree(src, dest, skip = protectedNames) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const from = path.join(src, ent.name), to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to, skip); else fs.copyFileSync(from, to);
  }
}
function removeTreeContents(dir, skip = protectedNames) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    fs.rmSync(path.join(dir, ent.name), { recursive: true, force: true });
  }
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(command + ' exited with ' + code + ': ' + (err || out))));
  });
}
async function waitForServer(seconds = 15) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { if (await portOpen(port)) return true; await sleep(400); }
  return false;
}
function startServer() {
  const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    cwd: appDir, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, HTML_UI_PORT: String(port) }
  });
  child.unref();
  return child.pid;
}

async function main() {
  if (!fs.existsSync(stageDir) || !fs.existsSync(path.join(stageDir, 'server.js'))) throw new Error('Staged GitHub update is missing server.js');
  writeStatus('waiting-for-server');
  if (!(await waitPortFree(30000))) throw new Error('Port ' + port + ' did not become available');
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'html-ui-backup-'));
  let candidatePid = null;
  try {
    copyTree(appDir, backup);
    writeStatus('installing');
    removeTreeContents(appDir);
    copyTree(stageDir, appDir);
    if (packageChanged || !fs.existsSync(path.join(appDir, 'node_modules'))) {
      writeStatus('installing-dependencies');
      const cmd = process.platform === 'win32' ? (process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')) : 'npm';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm install --omit=dev'] : ['install', '--omit=dev'];
      await run(cmd, args, { cwd: appDir });
    }
    writeStatus('starting-server');
    candidatePid = startServer();
    if (!(await waitForServer(15))) throw new Error('The updated server did not stay running; the previous version will be restored.');
    writeStatus('success', { message: 'GitHub update installed successfully.' });
    fs.rmSync(backup, { recursive: true, force: true });
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
  } catch (err) {
    writeStatus('rolling-back', { error: err.message });
    try {
      if (candidatePid && process.platform === 'win32') {
        const cmd = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
        await run(cmd, ['/d', '/c', 'taskkill', '/PID', String(candidatePid), '/T', '/F']).catch(() => {});
      } else if (candidatePid) { try { process.kill(candidatePid, 'SIGTERM'); } catch (_) {} }
    } catch (_) {}
    await sleep(800);
    try {
      await waitPortFree(8000);
      removeTreeContents(appDir);
      copyTree(backup, appDir);
      startServer();
      await waitForServer(15);
      writeStatus('failed', { error: err.message, message: 'Update failed; previous version restored.' });
    } catch (rollbackErr) {
      writeStatus('failed', { error: err.message + '; rollback failed: ' + rollbackErr.message });
    }
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    process.exitCode = 1;
  }
}
main().catch(err => { writeStatus('failed', { error: err.message }); process.exitCode = 1; });

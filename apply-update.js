const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const stageDir = path.resolve(process.argv[2]);
const appDir = path.resolve(process.argv[3] || __dirname);
const port = Number(process.argv[4] || 3010);
const protectedNames = new Set([
  'node_modules', '.git', 'smarthome_state.json', 'github_update.json',
  'restart-after-update.js', 'apply-update.js', 'START_WINDOWS.bat'
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  while (Date.now() < end) {
    if (!(await portOpen(port))) return true;
    await sleep(300);
  }
  return false;
}

function copyTree(src, dest, skip = protectedNames) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to, skip);
    else fs.copyFileSync(from, to);
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
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${command} exited with ${code}: ${err || out}`)));
  });
}

async function waitForServer(seconds = 10) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(400);
  }
  return false;
}

function startServer() {
  const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HTML_UI_PORT: String(port) }
  });
  child.unref();
  return child.pid;
}

async function main() {
  if (!fs.existsSync(stageDir) || !fs.existsSync(path.join(stageDir, 'server.js'))) throw new Error('Staged GitHub update is missing server.js');

  // The old server is already shutting down. Wait until its port is really free.
  if (!(await waitPortFree(30000))) throw new Error(`Port ${port} did not become available`);

  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'html-ui-backup-'));
  let candidatePid = null;
  try {
    // Keep a complete rollback copy of the current application files.
    copyTree(appDir, backup);

    // Apply staged files. User state, GitHub token, node_modules and updater
    // helpers are deliberately preserved.
    removeTreeContents(appDir);
    copyTree(stageDir, appDir);

    // Install dependencies only after the new package.json is in place.
    if (fs.existsSync(path.join(appDir, 'package.json'))) {
      const cmd = process.platform === 'win32'
        ? (process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'))
        : 'npm';
      const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm install --omit=dev']
        : ['install', '--omit=dev'];
      await run(cmd, args, { cwd: appDir });
    }

    // A runtime start is the final safety check. If the new server immediately
    // crashes, restore the known-good version automatically.
    candidatePid = startServer();
    if (!(await waitForServer(12))) {
      throw new Error('The updated server did not stay running; the previous version will be restored.');
    }

    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
    console.log('[UPDATE] Update installed and server is running.');
  } catch (err) {
    console.error('[UPDATE] Failed:', err.message);
    try {
      if (candidatePid && process.platform === 'win32') {
        const cmd = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
        await run(cmd, ['/d', '/c', 'taskkill', '/PID', String(candidatePid), '/T', '/F']).catch(() => {});
      } else if (candidatePid) {
        try { process.kill(candidatePid, 'SIGTERM'); } catch (_) {}
      }
    } catch (_) {}

    await sleep(800);
    try {
      await waitPortFree(8000);
      removeTreeContents(appDir);
      copyTree(backup, appDir);
      startServer();
      await waitForServer(12);
      console.log('[UPDATE] Previous version restored.');
    } catch (rollbackErr) {
      console.error('[UPDATE] Rollback failed:', rollbackErr.message);
    }
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    process.exitCode = 1;
  }
}

main().catch(err => { console.error('[UPDATE]', err); process.exitCode = 1; });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const serverPath = path.resolve(process.argv[2] || path.join(__dirname, 'server.js'));
const cwd = path.dirname(serverPath);
const port = Number(process.argv[3] || process.env.HTML_UI_PORT || 3010);

if (!fs.existsSync(serverPath)) process.exit(2);

function startNode() {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

if (process.platform !== 'win32') {
  startNode();
  process.exit(0);
}

// This helper is launched through `cmd /c start`, so it is independent of
// the server process that is about to exit. Wait until the old listener is
// actually gone before starting the new server.
const ps = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const script = `
$ErrorActionPreference = 'SilentlyContinue'
$port = ${port}
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) { break }
  Start-Sleep -Milliseconds 500
}
Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList @('${serverPath.replace(/'/g, "''")}') -WorkingDirectory '${cwd.replace(/'/g, "''")}' -WindowStyle Hidden
`;

try {
  // Run PowerShell synchronously inside this independent helper. The helper
  // itself is already detached, so waiting here does not tie it to Node.
  const psChild = spawn(ps, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script
  ], {
    cwd,
    stdio: 'ignore',
    windowsHide: true
  });
  psChild.on('close', () => process.exit(0));
  psChild.on('error', () => { try { startNode(); } finally { process.exit(0); } });
} catch (_) {
  startNode();
  process.exit(0);
}

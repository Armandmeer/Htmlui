const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const dgram = require("dgram");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
let FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
let FFMPEG_FALLBACK = null;
try { FFMPEG_FALLBACK = require("ffmpeg-static") || null; } catch (_) {}
if (!FFMPEG_FALLBACK) {
  const candidates = process.platform === 'win32'
    ? [path.join(__dirname,'node_modules','ffmpeg-static','ffmpeg.exe'), path.join(__dirname,'node_modules','ffmpeg-static','ffmpeg')]
    : [path.join(__dirname,'node_modules','ffmpeg-static','ffmpeg'), path.join(__dirname,'node_modules','ffmpeg-static','ffmpeg.exe')];
  FFMPEG_FALLBACK = candidates.find(x => { try { return fs.existsSync(x); } catch (_) { return false; } }) || null;
}
function ffmpegCandidates(){ return [...new Set([FFMPEG_BIN, FFMPEG_FALLBACK].filter(Boolean))]; }

// knxultimate is published with a default export.
// This fallback works with both CommonJS interop shapes.
const knxModule = require("knxultimate");
const KNXClient = knxModule.default || knxModule.KNXClient || knxModule;
const dptlib = knxModule.dptlib || (knxModule.default && knxModule.default.dptlib);

if (typeof KNXClient !== "function") {
  console.error("KNXClient kon niet worden geladen. Gevonden exports:", Object.keys(knxModule));
  process.exit(1);
}

const PORT = Number(process.env.HTML_UI_PORT || process.env.PORT || 3010);
const STATE_FILE = path.join(__dirname, "smarthome_state.json");
const GITHUB_CONFIG_FILE = path.join(__dirname, "github_update.json");
const UPDATE_STATUS_FILE = path.join(__dirname, "github-update-status.json");
const WEBOS_KEYS_FILE = path.join(__dirname, "webos_tv_keys.json");
const WEBOS_APPS_FILE = path.join(__dirname, "webos_tv_apps.json");
const NAX_MEDIA_CACHE_FILE = path.join(__dirname, "nax_media_cache.json");
const SETTINGS_SECURITY_FILE = path.join(__dirname, "settings_security.json");
const settingsSessions = new Map();
const settingsFailures = new Map();
const SETTINGS_SESSION_TTL = 35000;
function settingsCodeHash(code, salt) {
  return crypto.scryptSync(String(code), String(salt), 32).toString('hex');
}
function readSettingsSecurity() {
  try {
    const value = fs.existsSync(SETTINGS_SECURITY_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_SECURITY_FILE, 'utf8')) : null;
    if (value && value.salt && value.hash) return value;
  } catch (_) {}
  const salt = crypto.randomBytes(16).toString('hex');
  const value = { salt, hash: settingsCodeHash('2580', salt), updatedAt: new Date().toISOString() };
  fs.writeFileSync(SETTINGS_SECURITY_FILE, JSON.stringify(value, null, 2));
  return value;
}
function verifySettingsCode(code) {
  const saved = readSettingsSecurity();
  const actual = Buffer.from(settingsCodeHash(code, saved.salt), 'hex');
  const expected = Buffer.from(String(saved.hash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function settingsTokenFromRequest(req) {
  return String(req.headers['x-settings-token'] || '').trim();
}
function hasSettingsAccess(token) {
  const key = String(token || '').trim();
  const expiresAt = settingsSessions.get(key);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) { settingsSessions.delete(key); return false; }
  return true;
}
function extendSettingsAccess(token) {
  const key = String(token || '').trim();
  if (!hasSettingsAccess(key)) return false;
  settingsSessions.set(key, Date.now() + SETTINGS_SESSION_TTL);
  return true;
}
function createSettingsSession() {
  const token = crypto.randomBytes(32).toString('hex');
  settingsSessions.set(token, Date.now() + SETTINGS_SESSION_TTL);
  return token;
}
function writeSettingsCode(newCode) {
  const salt = crypto.randomBytes(16).toString('hex');
  const value = { salt, hash: settingsCodeHash(newCode, salt), updatedAt: new Date().toISOString() };
  fs.writeFileSync(SETTINGS_SECURITY_FILE, JSON.stringify(value, null, 2));
}
function configurationFieldsChanged(saved, input) {
  const project = value => ({
    rooms: Array.isArray(value && value.rooms) ? value.rooms : [],
    sliders: Array.isArray(value && value.sliders) ? value.sliders : [],
    securityDevices: Array.isArray(value && value.securityDevices) ? value.securityDevices : [],
    genericDevices: Array.isArray(value && value.genericDevices) ? value.genericDevices : [],
    deviceDrivers: Array.isArray(value && value.deviceDrivers) ? value.deviceDrivers : [],
    presets: value && value.presets && typeof value.presets === 'object' ? value.presets : {}
  });
  return JSON.stringify(project(saved)) !== JSON.stringify(project(input));
}

function normalizeSecurityPlacement(state) {
 const generic=Array.isArray(state.genericDevices)?state.genericDevices:[];
 const misplaced=generic.filter(x=>x&&['security','lock','motion'].includes(x.type));
 if(!misplaced.length)return false;
 const security=Array.isArray(state.securityDevices)?state.securityDevices:[];
 const ids=new Set(security.map(x=>x.id));
 for(const x of misplaced){
   if(ids.has(x.id))continue;
   security.push({...x,type:'security',securityType:x.securityType==='motion'||x.type==='motion'?'motion':'lock',controllable:x.controllable!==false&&x.controllable!=='false'});
   ids.add(x.id);
 }
 state.securityDevices=security;
 state.genericDevices=generic.filter(x=>!x||!['security','lock','motion'].includes(x.type));
 return true;
}
function readDashboardState() {
  try {
    const value = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}

function writeDashboardState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}


const placementState=readDashboardState();
if(normalizeSecurityPlacement(placementState)){
 fs.copyFileSync(STATE_FILE,STATE_FILE+'.before-security-placement');
 placementState.configRevision=(Number(placementState.configRevision)||0)+1;
 writeDashboardState(placementState);
}

function persistKNXConnection(connection, reconnect) {
  try {
    const list = value => Array.isArray(value) ? value.map(x => String(x).trim()).filter(Boolean) : [];
    const state = readDashboardState();
    state.knxConnection = {
      ip: String(connection.ip || "").trim(),
      port: Number(connection.port) || 3671,
      mode: connection.mode === "Multicast" ? "Multicast" : "TunnelUDP",
      physAddr: String(connection.physAddr || "").trim(),
      writeGa: String(connection.writeGa || "").trim(),
      feedbackGa: String(connection.feedbackGa || "").trim(),
      feedbackGAs: list(connection.feedbackGAs),
      switchFeedbackGAs: list(connection.switchFeedbackGAs),
      securityFeedbackGAs: list(connection.securityFeedbackGAs),
      cameraFeedbackGAs: list(connection.cameraFeedbackGAs),
      reconnect: !!reconnect
    };
    writeDashboardState(state);
  } catch (e) { console.error("[KNX] Could not save connection settings:", e.message); }
}

function setKNXReconnectEnabled(enabled) {
  const state = readDashboardState();
  if (!state.knxConnection || typeof state.knxConnection !== "object") return;
  state.knxConnection.reconnect = !!enabled;
  try { writeDashboardState(state); } catch (e) { console.error("[KNX] Could not save reconnect preference:", e.message); }
}

function savedKNXConnection() {
  const saved = readDashboardState().knxConnection;
  if (!saved || typeof saved !== "object" || saved.reconnect === false || !String(saved.ip || "").trim()) return null;
  return saved;
}
const STATE_BACKUP_FILE = path.join(__dirname, "smarthome_state.before-update.json");
const STATE_RESTORE_BACKUP_FILE = path.join(__dirname, "smarthome_state.before-github-restore.json");

function readGithubConfig() {
  try {
    if (!fs.existsSync(GITHUB_CONFIG_FILE)) return { url: "", token: "" };
    const v = JSON.parse(fs.readFileSync(GITHUB_CONFIG_FILE, "utf8"));
    return { url: String(v.url || ""), token: String(v.token || "") };
  } catch (_) { return { url: "", token: "" }; }
}

function writeGithubConfig(cfg) {
  fs.writeFileSync(GITHUB_CONFIG_FILE, JSON.stringify({ url: String(cfg.url || "").trim(), token: String(cfg.token || "") }, null, 2));
}

function parseGithubRepoUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a GitHub repository URL");
  // Accept normal GitHub repository URLs, URLs copied from a branch/path,
  // and the common .git suffix.
  raw = raw.replace(/^git@github\.com:/i, "https://github.com/");
  raw = raw.replace(/^git\+https?:\/\//i, "https://");
  if (!/^https?:\/\/github\.com\//i.test(raw)) {
    raw = `https://github.com/${raw.replace(/^\/+/, "")}`;
  }
  let u;
  try { u = new URL(raw); } catch (_) {
    throw new Error("Enter a GitHub repository URL, for example https://github.com/owner/repository");
  }
  if (u.hostname.toLowerCase() !== "github.com") {
    throw new Error("The GitHub URL must point to github.com");
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Enter a GitHub repository URL, for example https://github.com/owner/repository");
  }
  const owner = decodeURIComponent(parts[0]);
  const repo = decodeURIComponent(parts[1]).replace(/\.git$/i, "");
  if (!owner || !repo) throw new Error("GitHub owner and repository are required");
  return { owner, repo };
}

function httpGetBuffer(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https:") ? require("https") : require("http");
    const req = lib.get(url, { headers: { "User-Agent": "Html-ui/2.1", ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpGetBuffer(next, headers, redirects + 1).then(resolve, reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = data.toString("utf8").slice(0, 500);
          try { detail = JSON.parse(detail).message || detail; } catch (_) {}
          return reject(new Error(`GitHub returned HTTP ${res.statusCode}: ${detail}`));
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("GitHub request timed out")));
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`)));
  });
}

async function updateFromGithub() {
  const cfg = readGithubConfig();
  const { owner, repo } = parseGithubRepoUrl(cfg.url);
  if (!cfg.token) throw new Error("GitHub token is required");
  const auth = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  let repoInfo;
  try {
    repoInfo = JSON.parse((await httpGetBuffer(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, auth)).toString("utf8"));
  } catch (e) {
    if (/HTTP 404/.test(String(e.message || ""))) {
      throw new Error(`GitHub repository not found or token has no access: ${owner}/${repo}. For a private repository, give the token access to this repository with Contents: Read-only.`);
    }
    if (/HTTP 401/.test(String(e.message || ""))) {
      throw new Error("GitHub token is invalid or expired. Create a new token and grant it access to this repository.");
    }
    throw e;
  }
  const branch = repoInfo.default_branch || "main";
  let zip;
  try {
    zip = await httpGetBuffer(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(branch)}`, auth, 0);
  } catch (e) {
    if (/HTTP 404/.test(String(e.message || ""))) {
      throw new Error(`GitHub archive could not be downloaded for ${owner}/${repo} (${branch}). Check that the token has Contents: Read-only access.`);
    }
    throw e;
  }

  // Never replace the running application directly. Stage the GitHub files first;
  // an independent updater will validate/install them and can roll back if the
  // new server does not start. This prevents a bad GitHub commit from killing
  // the currently working dashboard permanently.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "html-ui-github-"));
  const zipPath = path.join(tmpRoot, "repo.zip");
  const extractDir = path.join(tmpRoot, "extract");
  const stageDir = path.join(tmpRoot, "stage");
  fs.mkdirSync(extractDir);
  fs.mkdirSync(stageDir);
  fs.writeFileSync(zipPath, zip);

  if (process.platform === "win32") {
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const psCommand = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
    await runCommand(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand]);
  } else {
    await runCommand("unzip", ["-q", zipPath, "-d", extractDir]);
  }

  const roots = fs.readdirSync(extractDir, { withFileTypes: true }).filter(x => x.isDirectory());
  if (!roots.length) throw new Error("GitHub archive is empty");
  const sourceRoot = path.join(extractDir, roots[0].name);
  const protectedNames = new Set(["node_modules", ".git", "smarthome_state.json", "smarthome_state.before-update.json", "github_update.json", "github-update-status.json", "webos_tv_keys.json", "webos_tv_apps.json", "settings_security.json"]);
  const copyTree = (src, dest) => {
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (protectedNames.has(ent.name)) continue;
      const from = path.join(src, ent.name), to = path.join(dest, ent.name);
      if (ent.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copyTree(from, to); }
      else fs.copyFileSync(from, to);
    }
  };
  copyTree(sourceRoot, stageDir);

  const stagedServer = path.join(stageDir, "server.js");
  const stagedPackage = path.join(stageDir, "package.json");
  if (!fs.existsSync(stagedServer)) throw new Error("GitHub update does not contain server.js; update cancelled.");
  if (!fs.existsSync(stagedPackage)) throw new Error("GitHub update does not contain package.json; update cancelled.");
  if (!fs.existsSync(path.join(stageDir, "apply-update.js"))) throw new Error("GitHub update does not contain apply-update.js; update cancelled.");

  // Syntax-check the candidate before stopping the live server.
  await runCommand(process.execPath, ["--check", stagedServer], { cwd: stageDir });

  let packageChanged = false;
  try {
    packageChanged = fs.readFileSync(stagedPackage, "utf8") !== fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
  } catch (_) {}

  return { owner, repo, branch, updatedAt: new Date().toISOString(), packageChanged, stageDir, tmpRoot };
}

async function restoreConfigurationFromGithub() {
  const cfg = readGithubConfig();
  const { owner, repo } = parseGithubRepoUrl(cfg.url);
  if (!cfg.token) throw new Error("GitHub token is required");
  const auth = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const repoInfo = JSON.parse((await httpGetBuffer(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, auth)).toString("utf8"));
  const branch = repoInfo.default_branch || "main";
  const rawHeaders = { ...auth, Accept: "application/vnd.github.raw+json" };
  let raw;
  try {
    raw = await httpGetBuffer(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/smarthome_state.json?ref=${encodeURIComponent(branch)}`, rawHeaders);
  } catch (error) {
    if (/HTTP 404/.test(String(error.message || ""))) throw new Error("GitHub does not contain smarthome_state.json");
    throw error;
  }
  let restored;
  try {
    restored = JSON.parse(raw.toString("utf8"));
    if (restored && restored.encoding === "base64" && restored.content) restored = JSON.parse(Buffer.from(restored.content, "base64").toString("utf8"));
  } catch (_) { throw new Error("The GitHub configuration is not valid JSON"); }
  if (!restored || typeof restored !== "object" || !Array.isArray(restored.rooms) || !Array.isArray(restored.sliders) || !Array.isArray(restored.securityDevices) || !Array.isArray(restored.genericDevices)) {
    throw new Error("The GitHub configuration is incomplete");
  }
  const current = readDashboardState();
  restored.configRevision = Math.max(Number(current.configRevision) || 0, Number(restored.configRevision) || 0) + 1;
  if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_RESTORE_BACKUP_FILE);
  const tempFile = STATE_FILE + ".github-restore.tmp";
  fs.writeFileSync(tempFile, JSON.stringify(restored, null, 2));
  fs.renameSync(tempFile, STATE_FILE);
  broadcast({ type: "state-update", state: restored });
  return { owner, repo, branch, rooms: restored.rooms.length, sliders: restored.sliders.length, securityDevices: restored.securityDevices.length, genericDevices: restored.genericDevices.length };
}

const DEFAULT = {
  ip: "192.168.200.50",
  port: 3671,
  mode: "TunnelUDP",
  physAddr: "1.1.253",
  writeGa: "1/1/69",
  feedbackGa: "2/1/69"
};

let knx = null;
let connected = false;
let lastKnxActivityAt = 0;
let config = { ...DEFAULT };
const sockets = new Set();
let githubUpdateInProgress = false;


// Internal mDNS hostname. Devices on the same LAN can open the dashboard at
// http://smarthome.local:3010 without knowing the server's current IP address.
// This is a small A-record responder for the standard mDNS address 224.0.0.251.
const MDNS_HOSTNAME = "smarthome.local";
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
let mdnsSocket = null;

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const info of entries || []) {
      if (info.family === "IPv4" && !info.internal && info.address) addresses.push(info.address);
    }
  }
  return [...new Set(addresses)];
}

function readDnsName(buf, offset) {
  const labels = [];
  let pos = offset;
  let jumped = false;
  let next = offset;
  for (let guard = 0; guard < 64 && pos < buf.length; guard++) {
    const len = buf[pos++];
    if (len === 0) {
      if (!jumped) next = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos >= buf.length) return null;
      const pointer = ((len & 0x3f) << 8) | buf[pos++];
      if (!jumped) next = pos;
      pos = pointer;
      jumped = true;
      continue;
    }
    if (len > 63 || pos + len > buf.length) return null;
    labels.push(buf.subarray(pos, pos + len).toString("utf8"));
    pos += len;
  }
  return { name: labels.join(".").toLowerCase(), nextOffset: next };
}

function buildMdnsAResponse(query, queryName, ips) {
  const answers = ips.filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (!answers.length) return null;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8400, 2); // response + authoritative
  header.writeUInt16BE(1, 4);      // one question
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  // Reuse the question section exactly as supplied.
  const questionEnd = queryName.nextOffset + 4;
  const question = query.subarray(12, questionEnd);
  const records = [];
  for (const ip of answers) {
    const octets = ip.split(".").map(Number);
    const rdata = Buffer.from(octets);
    const rr = Buffer.alloc(12 + rdata.length);
    rr.writeUInt16BE(0xc00c, 0); // pointer to QNAME
    rr.writeUInt16BE(1, 2);       // A
    rr.writeUInt16BE(1, 4);       // IN
    rr.writeUInt32BE(120, 6);     // TTL
    rr.writeUInt16BE(4, 10);
    rdata.copy(rr, 12);
    records.push(rr);
  }
  return Buffer.concat([header, question, ...records]);
}

function startMdns() {
  if (mdnsSocket) return;
  try {
    mdnsSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    mdnsSocket.on("error", err => console.error(`[mDNS] ${err.message}`));
    mdnsSocket.on("message", (msg, rinfo) => {
      try {
        if (msg.length < 12) return;
        const qdCount = msg.readUInt16BE(4);
        if (!qdCount) return;
        const qname = readDnsName(msg, 12);
        if (!qname || qname.name !== MDNS_HOSTNAME) return;
        const qtype = msg.readUInt16BE(qname.nextOffset);
        const rawQclass = msg.readUInt16BE(qname.nextOffset + 2);
        const qclass = rawQclass & 0x7fff;
        const wantsUnicast = !!(rawQclass & 0x8000);
        if (qclass !== 1 || (qtype !== 1 && qtype !== 255)) return;
        const response = buildMdnsAResponse(msg, qname, getLocalIPv4Addresses());
        if (!response) return;
        if (wantsUnicast) {
          mdnsSocket.send(response, 0, response.length, rinfo.port, rinfo.address);
        } else {
          mdnsSocket.send(response, 0, response.length, MDNS_PORT, MDNS_ADDRESS);
        }
      } catch (err) {
        console.error(`[mDNS] Query error: ${err.message}`);
      }
    });
    mdnsSocket.bind(MDNS_PORT, () => {
      try {
        mdnsSocket.addMembership(MDNS_ADDRESS);
        mdnsSocket.setMulticastTTL(255);
        console.log(`[mDNS] ${MDNS_HOSTNAME} actief op poort ${MDNS_PORT}`);
        console.log(`[mDNS] Dashboard: http://${MDNS_HOSTNAME}:${PORT}`);
      } catch (err) {
        console.error(`[mDNS] Kon multicast niet activeren: ${err.message}`);
      }
    });
  } catch (err) {
    console.error(`[mDNS] Niet beschikbaar: ${err.message}`);
    mdnsSocket = null;
  }
}
const CAMERA_RTSP = [
  "rtsp://192.168.200.1:7447/gtWQd9KSBjNCZg60",
  "rtsp://admin:Eigen4dm1n2025@192.168.200.84:554/cam/realmonitor?channel=1&subtype=1",
  "rtsp://admin:Eigen4dm1n2025@192.168.200.83:554/cam/realmonitor?channel=1&subtype=1",
  "rtsp://admin:Eigen4dm1n2023!@192.168.200.81:554/live/ch00_0"
];

function streamRtspUrl(req, res, rtspUrl) {
  if (!/^rtsps?:\/\//i.test(String(rtspUrl || ''))) { res.writeHead(400, { "Content-Type":"text/plain; charset=utf-8" }); return res.end("Only RTSP/RTSPS camera URLs can be proxied."); }
  res.writeHead(200,{"Content-Type":"multipart/x-mixed-replace; boundary=frame","Cache-Control":"no-store, no-cache, must-revalidate, proxy-revalidate","Pragma":"no-cache","Connection":"close","Access-Control-Allow-Origin":"*"});
  let ff=null,closed=false,buffer=Buffer.alloc(0),candidateIndex=0;
  const candidates=ffmpegCandidates();
  const cleanup=()=>{if(closed)return;closed=true;try{if(ff)ff.kill('SIGTERM')}catch(_){} };
  req.on('close',cleanup);
  const start=()=>{
    const bin=candidates[candidateIndex++];
    if(!bin){ console.error('[CAMERA] ffmpeg niet beschikbaar. Installeer dependencies met npm install of zet FFMPEG_PATH.'); try{res.end()}catch(_){} return; }
    console.log('[CAMERA] ffmpeg:',bin);
    ff=spawn(bin,["-hide_banner","-loglevel","warning","-rtsp_transport","tcp","-fflags","nobuffer","-flags","low_delay","-i",String(rtspUrl),"-an","-c:v","mjpeg","-q:v","5","-r","10","-f","mjpeg","pipe:1"],{windowsHide:true});
    ff.on('error',err=>{console.error('[CAMERA] ffmpeg error:',err.message);try{ff.kill()}catch(_){};start();});
    ff.stdout.on('data',chunk=>{if(closed)return;buffer=Buffer.concat([buffer,chunk]);while(true){const a=buffer.indexOf(Buffer.from([0xff,0xd8]));if(a<0){if(buffer.length>1024*1024)buffer=buffer.slice(-65536);break}const b=buffer.indexOf(Buffer.from([0xff,0xd9]),a+2);if(b<0){if(a>0)buffer=buffer.slice(a);break}const jpg=buffer.slice(a,b+2);buffer=buffer.slice(b+2);try{res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '+jpg.length+'\r\n\r\n');res.write(jpg);res.write('\r\n')}catch(_){cleanup();break}}});
    ff.stderr.on('data',data=>{const msg=String(data).trim();if(msg)console.error('[CAMERA]',msg)});
  };
  start();
}

function streamCamera(req, res, cameraIndex = 0) {
  const rtspUrl = CAMERA_RTSP[cameraIndex];
  if (!rtspUrl) { res.writeHead(404); return res.end("Camera not found"); }
  return streamRtspUrl(req, res, rtspUrl);
}
function streamConfiguredCamera(req, res, encodedId) {
  let id = '';
  try { id = decodeURIComponent(String(encodedId || '')); } catch (_) {}
  if (!id) { res.writeHead(400); return res.end('Camera id missing'); }
  let state = {};
  try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
  const devices = Array.isArray(state.genericDevices) ? state.genericDevices : [];
  const camera = devices.find(x => String(x.id || '') === id && x.type === 'camera');
  if (!camera || !camera.url) { res.writeHead(404); return res.end('Configured camera not found'); }
  if (!/^rtsps?:\/\//i.test(String(camera.url))) { res.writeHead(400, { 'Content-Type':'text/plain; charset=utf-8' }); return res.end('Configured camera is not an RTSP/RTSPS source'); }
  return streamRtspUrl(req, res, String(camera.url));
}
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

const avStatuses = new Map();
const avNextChecks = new Map();
const avChecksRunning = new Set();
function readWebosAppsCache() {
  try {
    const value = fs.existsSync(WEBOS_APPS_FILE) ? JSON.parse(fs.readFileSync(WEBOS_APPS_FILE, 'utf8')) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
const avAppsCache = new Map(Object.entries(readWebosAppsCache()));
function saveWebosAppsCache() {
  const value = {};
  for (const [id, entry] of avAppsCache.entries()) value[id] = entry;
  fs.writeFileSync(WEBOS_APPS_FILE, JSON.stringify(value, null, 2));
}

function validIpv4(value) {
  const parts = String(value || '').trim().split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
function probeTcpPort(ip, port, timeoutMs = 550) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port });
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function probeLgWebos(ip) {
  if (!validIpv4(ip)) return { online: false, error: 'Invalid or missing IP address' };
  const results = await Promise.all([probeTcpPort(ip, 3001), probeTcpPort(ip, 3000)]);
  const online = results.some(Boolean);
  return { online, error: online ? '' : 'LG webOS control is not reachable' };
}function sendWakeOnLan(macAddress) {
  return new Promise((resolve, reject) => {
    const hex = String(macAddress || '').replace(/[^0-9a-f]/gi, '');
    if (!/^[0-9a-f]{12}$/i.test(hex)) return reject(new Error('Enter a valid TV MAC address'));
    const mac = Buffer.from(hex, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let index = 0; index < 16; index++) mac.copy(packet, 6 + index * 6);
    const socket = dgram.createSocket('udp4');
    socket.once('error', error => { try { socket.close(); } catch (_) {} reject(error); });
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch (_) {}
      socket.send(packet, 0, packet.length, 9, '255.255.255.255', error => {
        try { socket.close(); } catch (_) {}
        if (error) reject(error); else resolve();
      });
    });
  });
}
function readWebosKeys() {
  try {
    const value = fs.existsSync(WEBOS_KEYS_FILE) ? JSON.parse(fs.readFileSync(WEBOS_KEYS_FILE, 'utf8')) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
function saveWebosClientKey(id, clientKey) {
  if (!id || !clientKey) return;
  const keys = readWebosKeys();
  keys[String(id)] = String(clientKey);
  fs.writeFileSync(WEBOS_KEYS_FILE, JSON.stringify(keys, null, 2));
}
function lgWebosTurnOffAt(url, tv, clientKey) {
  return new Promise((resolve, reject) => {
    let settled = false, commandSent = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch (_) {}
      if (error) reject(error); else resolve();
    };
    const socket = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 6000 });
    const timeout = setTimeout(() => finish(new Error('LG webOS pairing or power command timed out')), 45000);
    socket.on('open', () => {
      const permissions = ['LAUNCH','LAUNCH_WEBAPP','APP_TO_APP','CONTROL_AUDIO','CONTROL_INPUT_MEDIA_PLAYBACK','CONTROL_POWER','READ_INSTALLED_APPS','CONTROL_DISPLAY','CONTROL_INPUT_JOYSTICK','CONTROL_INPUT_MEDIA_RECORDING','CONTROL_INPUT_TV','READ_INPUT_DEVICE_LIST','READ_NETWORK_STATE','READ_TV_CHANNEL_LIST','WRITE_NOTIFICATION_TOAST','CONTROL_INPUT_TEXT','CONTROL_MOUSE_AND_KEYBOARD','READ_CURRENT_CHANNEL','READ_RUNNING_APPS'];
      const payload = { pairingType: 'PROMPT', manifest: { manifestVersion: 1, permissions } };
      if (clientKey) payload['client-key'] = clientKey;
      socket.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
    });
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch (_) { return; }
      if (message.type === 'registered') {
        const newKey = message.payload && message.payload['client-key'];
        if (newKey) saveWebosClientKey(tv.id, newKey);
        commandSent = true;
        socket.send(JSON.stringify({ type: 'request', id: 'power_off_1', uri: 'ssap://system/turnOff', payload: {} }));
        setTimeout(() => finish(), 1800);
        return;
      }
      if (message.id === 'power_off_1') {
        if (message.type === 'error') finish(new Error(message.error || 'LG webOS rejected the power command'));
        else finish();
        return;
      }
      if (message.type === 'error') finish(new Error(message.error || 'LG webOS pairing failed'));
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (commandSent) finish(); else finish(new Error('LG webOS connection closed before pairing completed')); });
  });
}
async function lgWebosTurnOff(tv) {
  const ip = String(tv.ipAddress || '').trim();
  if (!validIpv4(ip)) throw new Error('Enter a valid LG TV IP address');
  const key = readWebosKeys()[String(tv.id || '')] || '';
  let firstError = null;
  for (const url of ['wss://' + ip + ':3001', 'ws://' + ip + ':3000']) {
    try { await lgWebosTurnOffAt(url, tv, key); return; }
    catch (error) { if (!firstError) firstError = error; }
  }
  throw firstError || new Error('Could not connect to LG webOS TV');
}
function lgWebosRequestAt(url, tv, clientKey, uri, payload = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false, registered = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch (_) {}
      if (error) reject(error); else resolve(result || {});
    };
    const socket = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: Math.min(timeoutMs, 1800) });
    const timeout = setTimeout(() => finish(new Error('LG webOS request timed out')), timeoutMs);
    socket.on('open', () => {
      const permissions = ['LAUNCH','LAUNCH_WEBAPP','APP_TO_APP','CONTROL_AUDIO','CONTROL_INPUT_MEDIA_PLAYBACK','CONTROL_POWER','READ_INSTALLED_APPS','CONTROL_DISPLAY','CONTROL_INPUT_JOYSTICK','CONTROL_INPUT_MEDIA_RECORDING','CONTROL_INPUT_TV','READ_INPUT_DEVICE_LIST','READ_NETWORK_STATE','READ_TV_CHANNEL_LIST','WRITE_NOTIFICATION_TOAST','CONTROL_INPUT_TEXT','CONTROL_MOUSE_AND_KEYBOARD','READ_CURRENT_CHANNEL','READ_RUNNING_APPS'];
      const registerPayload = { pairingType: 'PROMPT', manifest: { manifestVersion: 1, permissions } };
      if (clientKey) registerPayload['client-key'] = clientKey;
      socket.send(JSON.stringify({ type: 'register', id: 'register_query', payload: registerPayload }));
    });
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch (_) { return; }
      if (message.type === 'registered') {
        registered = true;
        const newKey = message.payload && message.payload['client-key'];
        if (newKey) saveWebosClientKey(tv.id, newKey);
        socket.send(JSON.stringify({ type: 'request', id: 'webos_query', uri, payload: payload || {} }));
        return;
      }
      if (message.id === 'webos_query') {
        if (message.type === 'error') finish(new Error(message.error || 'LG webOS rejected the request'));
        else finish(null, message.payload || {});
        return;
      }
      if (message.type === 'error') finish(new Error(message.error || 'LG webOS pairing failed'));
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!settled) finish(new Error(registered ? 'LG webOS closed before replying' : 'LG webOS pairing was not completed')); });
  });
}
async function lgWebosRequest(tv, uri, payload = {}, options = {}) {
  const ip = String(tv.ipAddress || '').trim();
  if (!validIpv4(ip)) throw new Error('Enter a valid LG TV IP address');
  const clientKey = readWebosKeys()[String(tv.id || '')] || '';
  if (!clientKey && options.allowPairing !== true) throw new Error('LG webOS is not paired yet');
  const ports = await Promise.all([probeTcpPort(ip, 3001), probeTcpPort(ip, 3000)]);
  const urls = [];
  if (ports[0]) urls.push('wss://' + ip + ':3001');
  if (ports[1]) urls.push('ws://' + ip + ':3000');
  if (!urls.length) throw new Error('LG webOS control is not reachable');
  let firstError = null;
  for (const url of urls) {
    try { return await lgWebosRequestAt(url, tv, clientKey, uri, payload, options.timeoutMs || (options.allowPairing ? 45000 : 5000)); }
    catch (error) { if (!firstError) firstError = error; }
  }
  throw firstError || new Error('LG webOS request failed');
}
async function getLgWebosPowerStatus(tv) {
  try {
    const result = await lgWebosRequest(tv, 'ssap://com.webos.service.tvpower/power/getPowerState', {}, { timeoutMs: 3500 });
    const rawState = String(result.state || result.powerState || result.processing || '').trim();
    const normalized = rawState.toLowerCase();
    const offlineStates = new Set(['active standby', 'standby', 'suspend', 'off', 'power off', 'screen off']);
    const online = !!normalized && !offlineStates.has(normalized);
    return { online, powerState: rawState || (online ? 'Active' : 'Standby'), error: '' };
  } catch (error) {
    return { online: false, powerState: 'Off', error: error.message };
  }
}
async function getLgWebosVolume(tv) {
  const result = await lgWebosRequest(tv, 'ssap://audio/getVolume', {}, { timeoutMs: 4000 });
  const status = result && result.volumeStatus && typeof result.volumeStatus === 'object' ? result.volumeStatus : result;
  const volume = Number(status && status.volume);
  if (!Number.isFinite(volume)) throw new Error('LG webOS returned no volume value');
  return { volume: Math.max(0, Math.min(100, Math.round(volume))), muted: !!(status.muted ?? status.muteStatus) };
}
function fetchTvResource(resourceUrl, expectedIp) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(resourceUrl); } catch (_) { return reject(new Error('Invalid LG app icon URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== expectedIp) return reject(new Error('LG app icon URL was rejected'));
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const request = lib.get(parsed, { rejectUnauthorized: false, timeout: 5000 }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); return reject(new Error('LG app icon returned HTTP ' + response.statusCode)); }
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length <= 1024 * 1024) chunks.push(chunk); else request.destroy(new Error('LG app icon is too large')); });
      response.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: response.headers['content-type'] || 'image/png' }));
    });
    request.on('error', reject);
  });
}
function configuredTvById(id) {
  const state = readDashboardState();
  const devices = Array.isArray(state.genericDevices) ? state.genericDevices : [];
  return devices.find(device => String(device.id || '') === String(id || '') && device.type === 'av' && (!device.avType || device.avType === 'tv'));
}
async function monitorAvDevices() {
  let state = {};
  try { state = readDashboardState(); } catch (_) {}
  const devices = (Array.isArray(state.genericDevices) ? state.genericDevices : []).filter(device => device && device.type === 'av' && (!device.avType || device.avType === 'tv'));
  const ids = new Set(devices.map(device => String(device.id || '')));
  for (const key of [...avStatuses.keys()]) if (!ids.has(key)) { avStatuses.delete(key); avNextChecks.delete(key); }
  const now = Date.now();
  for (const device of devices) {
    const id = String(device.id || '');
    if (!id || avChecksRunning.has(id) || now < Number(avNextChecks.get(id) || 0)) continue;
    const intervalSeconds = Math.max(1, Math.min(300, Number(device.pingIntervalSec) || 3));
    avNextChecks.set(id, now + intervalSeconds * 1000);
    avChecksRunning.add(id);
    getLgWebosPowerStatus(device).then(async result => {
      let volume = null, muted = false;
      if (result.online) {
        try { const audio = await getLgWebosVolume(device); volume = audio.volume; muted = audio.muted; } catch (_) {}
      }
      const previous = avStatuses.get(id) || {};
      const status = { online: !!result.online, powerState: result.powerState || (result.online ? 'Active' : 'Off'), error: result.error || '', checkedAt: new Date().toISOString(), ipAddress: String(device.ipAddress || '').trim(), volume: volume === null ? (result.online ? previous.volume ?? null : null) : volume, muted };
      avStatuses.set(id, status);
      broadcast({ type: 'av-status', id, status });
    }).finally(() => avChecksRunning.delete(id));
  }
}
setInterval(monitorAvDevices, 1000);
// ---------- Crestron DM-NAX-4ZSA-50 / Media Player 2.0 ----------
const naxUuidNode=crypto.randomBytes(6);naxUuidNode[0]|=1;const naxUuidClock=crypto.randomBytes(2);let naxUuidLastMs=0,naxUuidTicks=0;
function naxUuidV1(){const now=Date.now();naxUuidTicks=now===naxUuidLastMs?(naxUuidTicks+1)%10000:0;naxUuidLastMs=now;const timestamp=BigInt(now)*10000n+0x01b21dd213814000n+BigInt(naxUuidTicks),low=Number(timestamp&0xffffffffn)>>>0,mid=Number((timestamp>>32n)&0xffffn),high=(Number((timestamp>>48n)&0x0fffn)|0x1000),seq=((naxUuidClock[0]<<8)|naxUuidClock[1])&0x3fff,seqHi=((seq>>8)|0x80)&0xff,seqLo=seq&0xff,hex=value=>value.toString(16).padStart(2,'0');return low.toString(16).padStart(8,'0')+'-'+mid.toString(16).padStart(4,'0')+'-'+high.toString(16).padStart(4,'0')+'-'+hex(seqHi)+hex(seqLo)+'-'+Array.from(naxUuidNode,hex).join('');}
const NAX_REGISTERING_CLIENT_ID='HTMLUI-NAX-'+process.pid;
const naxUnits = new Map();
const naxDeviceStates = new Map();
function readNaxMediaCache() { try { const value=fs.existsSync(NAX_MEDIA_CACHE_FILE)?JSON.parse(fs.readFileSync(NAX_MEDIA_CACHE_FILE,'utf8')):{}; return value&&typeof value==='object'&&!Array.isArray(value)?value:{}; } catch (_) { return {}; } }
const naxMediaCache=readNaxMediaCache();
function naxMediaCacheKey(device){return String(device&&device.naxHost||'').trim()+'|'+String(device&&device.naxClientId||'').trim();}
function saveNaxMediaCache(){try{fs.writeFileSync(NAX_MEDIA_CACHE_FILE,JSON.stringify(naxMediaCache,null,2))}catch(_){}}
function naxPresetIdentity(item){return String(item&&item.profile||'')+'|'+String(item&&item.id||item&&item.name||'');}
function naxMergePresetCache(device,incoming){
  const key=naxMediaCacheKey(device),current=naxMediaCache[key]&&Array.isArray(naxMediaCache[key].presets)?naxMediaCache[key].presets:[],merged=new Map(current.map(item=>[naxPresetIdentity(item),item]));
  for(const item of Array.isArray(incoming)?incoming:[]){const id=naxPresetIdentity(item),sameName=current.find(old=>String(old&&old.name||'')===String(item&&item.name||'')),previous=merged.get(id)||sameName||{};if(sameName&&naxPresetIdentity(sameName)!==id)merged.delete(naxPresetIdentity(sameName));merged.set(id,{...previous,...item,icon:item.icon||previous.icon||'',signedData:item.signedData||previous.signedData||null,iconData:item.iconData||previous.iconData||'',iconContentType:item.iconContentType||previous.iconContentType||''});}
  const presets=Array.from(merged.values()).filter(item=>item&&item.id!=null).slice(0,8),serialized=JSON.stringify(presets);
  if(serialized!==JSON.stringify(current)){naxMediaCache[key]={presets,updatedAt:new Date().toISOString()};saveNaxMediaCache();}
  return presets;
}
function naxRememberPresetImage(device,preset,data,contentType){
  if(!preset||!data||!data.length)return;const key=naxMediaCacheKey(device),presets=naxMergePresetCache(device,[preset]),id=naxPresetIdentity(preset),item=presets.find(value=>naxPresetIdentity(value)===id);if(!item)return;
  const encoded=data.toString('base64');if(item.iconData!==encoded||item.iconContentType!==contentType){item.iconData=encoded;item.iconContentType=contentType||'image/png';naxMediaCache[key]={presets,updatedAt:new Date().toISOString()};saveNaxMediaCache();}
}
function naxRemoveCachedPresets(device,ids){const key=naxMediaCacheKey(device),remove=new Set((ids||[]).map(String)),current=naxMediaCache[key]&&Array.isArray(naxMediaCache[key].presets)?naxMediaCache[key].presets:[],presets=current.filter(item=>!remove.has(String(item&&item.id)));naxMediaCache[key]={presets,updatedAt:new Date().toISOString()};saveNaxMediaCache();}

function naxDevices() {
  const state = readDashboardState();
  return (Array.isArray(state.genericDevices) ? state.genericDevices : []).filter(device => device && device.type === 'av' && device.avType === 'nax');
}
function naxUnitKey(device) {
  return [String(device.naxHost || '').trim(), String(device.naxClientId || '').trim(), String(device.naxClientSecret || '').trim()].join('|');
}
function naxPlayerNumber(value) { return Math.max(1, Math.min(5, Number(value) || 1)); }
function naxPlayerIdForNumber(value) { return 'Player' + String(naxPlayerNumber(value)).padStart(2, '0'); }
function naxPlayerMappings(device) {
  const mappings = [];
  const hasNew = [1,2,3,4,5].some(number => String(device['naxRoom' + number] || '').trim());
  for (let number = 1; number <= 5; number++) {
    let room = String(device['naxRoom' + number] || '').trim();
    if (!hasNew && number === naxPlayerNumber(device.naxPlayer)) room = String(device.room || '').trim();
    if (room) mappings.push({ number, room, output: String(device['naxOutput' + number] || '').trim() });
  }
  return mappings;
}
function naxResolveTarget(rawId) {
  const text = String(rawId || ''), split = text.lastIndexOf('::'), baseId = split > 0 ? text.slice(0, split) : text;
  const device = naxDevices().find(item => String(item.id || '') === baseId);
  if (!device) return null;
  const number = split > 0 ? naxPlayerNumber(text.slice(split + 2)) : naxPlayerNumber(device.naxPlayer);
  return { device, number, virtualId: String(device.id || '') + '::' + number };
}
function naxDeepMerge(target, source) {
  if (source === '' && target) return target;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  target = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  for (const [key, value] of Object.entries(source)) target[key] = naxDeepMerge(target[key], value);
  return target;
}
function naxApplyFavorites(unit,profiles){if(!profiles||typeof profiles!=='object')return;if(Object.values(profiles).some(profile=>Object.prototype.hasOwnProperty.call(profile||{},'Favorites')))unit.favoritesLoaded=true;const pending=unit.deletedFavoriteIds||{},now=Date.now();for(const[id,until]of Object.entries(pending))if(now>=Number(until||0))delete pending[id];for(const[profileKey,profileData]of Object.entries(profiles)){const previous=unit.favorites[profileKey]||{},next=naxDeepMerge(previous,{...(profileData||{})});if(Object.prototype.hasOwnProperty.call(profileData||{},'Favorites')){const incoming=(profileData&&profileData.Favorites)||{},prior=previous.Favorites||{};next.Favorites=Object.fromEntries(Object.entries(incoming).map(([id,value])=>[id,naxDeepMerge(prior[id]||{},value||{})]));for(const id of Object.keys(pending))delete next.Favorites[id]}unit.favorites[profileKey]=next;}}
function naxSplitJson(text) {
  const output = []; let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) { if (char === '{' || char === '[') { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth === 0) { output.push(text.slice(start, index + 1)); start = -1; }
  }
  return output;
}
function naxFindSession(node) {
  function walk(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.RegisteredClientList && typeof value.RegisteredClientList === 'object') {
      for (const [sessionId, item] of Object.entries(value.RegisteredClientList)) if (item && item.RegisteredClientId === NAX_REGISTERING_CLIENT_ID) return sessionId;
    }
    for (const child of Object.values(value)) { const found = walk(child); if (found) return found; }
    return null;
  }
  return walk(node && node.Device && node.Device.SubscriptionMgr);
}
function naxAuthHeader(device) {
  const host = String(device.naxHost || '').trim();
  const clientId = String(device.naxClientId || '').trim();
  const secret = String(device.naxClientSecret || '').trim();
  const uri = 'wss://' + host + '/subscriptionmgr';
  const nonce = naxUuidV1(), timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(clientId + 'GET' + uri + timestamp + nonce).digest('base64');
  return 'CrestronAuth-SHA256 ' + Buffer.from(clientId + ':' + signature + ':' + nonce + ':' + timestamp).toString('base64');
}
function naxSend(unit, message) {
  if (!unit.ws || unit.ws.readyState !== WebSocket.OPEN) throw new Error('NAX connection is not open');
  unit.ws.send(JSON.stringify(message));
}
function naxGetObject(unit, objectPath) {
  naxSend(unit, { Device: { SubscriptionMgr: { RequestAction: { MsgId: naxUuidV1(), RegistrationAction: 'GetCresNextObject', RegistrationActionOptions: { RcSessionId: unit.sessionId, CresNextObject: objectPath } } } } });
}
function naxSubscribe(unit) {
  if (!unit.sessionId) return;
  const paths = ['/Device/MediaNavigation/RegisteredClientMenus/' + unit.sessionId, '/Device/MediaFavorites'];
  for (let index = 1; index <= 5; index++) paths.push('/Device/MediaPlayerNeXt/Players/Player' + String(index).padStart(2, '0'));
  try { naxSend(unit, { Device: { SubscriptionMgr: { RequestAction: { MsgId: naxUuidV1(), RegistrationAction: 'SubscribeToObject', RegistrationActionOptions: { RcSessionId: unit.sessionId, CresNextPath: paths } } } } }); } catch (_) {}
  for (const objectPath of paths) { try { naxGetObject(unit, objectPath); } catch (_) {} }
  for (let profile = 1; profile <= 5; profile++) {
    try { naxSend(unit, { Device: { MediaFavorites: { RequestAction: { RcSessionId: unit.sessionId, MsgId: naxUuidV1(), ProfileKey: 'Profile' + profile, FavoritesAction: 'ListFavorites', FavoritesActionOptions: {} } } } }); } catch (_) {}
  }
}
function naxConnect(unit) {
  clearTimeout(unit.reconnectTimer); clearTimeout(unit.registerTimer);
  const device = unit.device;
  const host = String(device.naxHost || '').trim();
  if (!validIpv4(host) || !device.naxClientId || !device.naxClientSecret) { unit.error = 'Enter NAX IP address, UUID and secret'; return; }
  try { if (unit.ws) unit.ws.terminate(); } catch (_) {}
  unit.connected = false; unit.socketOpen = false; unit.sessionId = ''; unit.error = '';
  const socket = new WebSocket('wss://' + host + '/subscriptionmgr', { headers: { Authorization: naxAuthHeader(device) }, rejectUnauthorized: false, handshakeTimeout: 6000 });
  unit.ws = socket;
  const register = () => {
    if (!unit.socketOpen || unit.sessionId || socket !== unit.ws) return;
    try { naxSend(unit, { Device: { SubscriptionMgr: { RequestAction: { MsgId: naxUuidV1(), RegistrationAction: 'RegisterClient', RegistrationActionOptions: { RegisteringClientIds: [NAX_REGISTERING_CLIENT_ID] } } } } }); } catch (_) {}
    unit.registerTimer = setTimeout(register, 1800);
  };
  socket.on('open', () => { unit.socketOpen = true; register(); });
  socket.on('message', raw => {
    for (const chunk of naxSplitJson(String(raw))) {
      try {
        const message = JSON.parse(chunk), found = naxFindSession(message);
        if (!unit.sessionId && found) { unit.sessionId = found; unit.connected = true; unit.error = ''; clearTimeout(unit.registerTimer); naxSubscribe(unit); }
        const players = message && message.Device && message.Device.MediaPlayerNeXt && message.Device.MediaPlayerNeXt.Players;
        if (players) unit.players = naxDeepMerge(unit.players, players);
        const favorites = message && message.Device && message.Device.MediaFavorites && message.Device.MediaFavorites.Profiles;
        if (favorites) {
          naxApplyFavorites(unit,favorites);
          const received=naxFavoriteList(unit,false); if(received.length)naxMergePresetCache(unit.device,received);
        }
        const navigation = message && message.Device && message.Device.MediaNavigation && message.Device.MediaNavigation.RegisteredClientMenus;
        if (navigation && unit.sessionId && navigation[unit.sessionId]) { unit.menu = naxDeepMerge(unit.menu, navigation[unit.sessionId]); unit.menuPending = false; unit.menuUpdatedAt = Date.now(); }
        if (favorites) for (const [profileKey, profileData] of Object.entries(favorites)) {
          const notification=profileData&&profileData.Notification, pending=unit.pendingFavorites&&unit.pendingFavorites[profileKey], notiId=notification&&(notification.NotiId||notification.NotiID);
          if(pending&&notiId){try{naxSend(unit,{Device:{MediaFavorites:{RequestAction:{RcSessionId:unit.sessionId,MsgId:naxUuidV1(),ProfileKey:profileKey,FavoritesAction:'Notification',FavoritesActionOptions:{NotiId:notiId,UserInputSelected:'OK',UserInputText:pending.name}}}}});delete unit.pendingFavorites[profileKey];setTimeout(()=>naxListFavorites(unit,profileKey),900)}catch(_){}}
        }
        const outputChannels = message && message.Device && message.Device.OutputChannels && message.Device.OutputChannels.Channels;
        if (outputChannels) unit.channels = naxDeepMerge(unit.channels, outputChannels);
        const zones = message && message.Device && message.Device.ZoneOutputs && message.Device.ZoneOutputs.Zones;
        if (zones) for (const [zoneId,zone] of Object.entries(zones)) unit.channels[zoneId]={...(unit.channels[zoneId]||{}),...(zone||{}),...((zone&&zone.ZoneAudio)||{}),_kind:'zone'};
        unit.updatedAt = new Date().toISOString();
      } catch (error) { unit.error = 'NAX data: ' + error.message; }
    }
  });
  socket.on('error', error => { unit.error = error.message; });
  socket.on('close', () => { if (socket !== unit.ws) return; unit.connected = false; unit.socketOpen = false; unit.sessionId = ''; clearTimeout(unit.registerTimer); unit.reconnectTimer = setTimeout(() => naxConnect(unit), 4000); });
}
function naxReconcile() {
  const devices = naxDevices(), activeKeys = new Set();
  for (const device of devices) {
    const key = naxUnitKey(device); activeKeys.add(key);
    if (!key.replace(/\|/g, '')) continue;
    let unit = naxUnits.get(key);
    if (!unit) { unit = { key, device: { ...device }, ws: null, connected: false, socketOpen: false, sessionId: '', error: '', players: {}, favorites: {}, userProfiles: {}, menu: {}, menuPending: false, menuRequestedAt: 0, menuHistory: {}, pendingFavorites: {}, recentFavoriteData: {}, pendingVolumes: {}, favoritesLoaded: false, channels: {}, cookies: {}, xsrf: '', restAuth: 'unknown', updatedAt: '', nextRest: 0 }; naxUnits.set(key, unit); naxConnect(unit); }
    else {
      const credentialSignature = String(device.naxRestUsername || '') + '\0' + String(device.naxRestPassword || '');
      if (unit.restCredentialSignature !== credentialSignature) { unit.cookies = {}; unit.xsrf = ''; unit.restAuth = 'unknown'; unit.restRetryAt = 0; unit.restCredentialSignature = credentialSignature; }
      unit.device = { ...device };
    }
  }
  for (const [key, unit] of naxUnits.entries()) if (!activeKeys.has(key)) { try { unit.ws && unit.ws.terminate(); } catch (_) {} clearTimeout(unit.reconnectTimer); clearTimeout(unit.registerTimer); naxUnits.delete(key); }
}
function naxPlayerAction(unit, playerId, action, options = {}) {
  if (!unit || !unit.sessionId) throw new Error('NAX Media Player 2.0 is not connected');
  naxSend(unit, { Device: { MediaPlayerNeXt: { RequestAction: { RcSessionId: unit.sessionId, MsgId: naxUuidV1(), PlayerId: playerId, ActionId: action, ActionIdOptions: options } } } });
}
function naxAvailableActions(player) {
  const raw = player && (player.AvailableActions || player.Player && player.Player.AvailableActions) || [];
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === 'object') return Object.keys(raw).filter(key => raw[key] !== false);
  return [];
}
function naxProfileForPlayer(unit, playerNumber) {
  const playerId=naxPlayerIdForNumber(playerNumber), player=unit&&unit.players&&unit.players[playerId]||{}, inner=player.Player||{}, now=inner.NowPlayingData||player.NowPlayingData||{};
  const candidates=[player.ProfileKey,inner.ProfileKey,now.ProfileKey,unit&&unit.menu&&unit.menu.ProfileKey,...Object.keys(unit&&unit.userProfiles||{}),...Object.keys(unit&&unit.favorites||{})];
  return String(candidates.find(value=>/^Profile\d+$/i.test(String(value||'')))||'Profile1');
}
function naxListFavorites(unit,profileKey){if(!unit||!unit.sessionId)return;naxSend(unit,{Device:{MediaFavorites:{RequestAction:{RcSessionId:unit.sessionId,MsgId:naxUuidV1(),ProfileKey:profileKey,FavoritesAction:'ListFavorites',FavoritesActionOptions:{}}}}});}
function naxMenuRequest(unit, profileKey, menuCategory, options) {
  if (!unit || !unit.sessionId) throw new Error('NAX Media Navigation is not connected');
  unit.menuPending=true;unit.menuRequestedAt=Date.now();unit.menuError='';
  const payload={Device:{MediaNavigation:{RequestAction:{RcSessionId:unit.sessionId,MsgId:naxUuidV1(),ProfileKey:profileKey,MenuCategory:menuCategory,MenuCategoryOptions:options||{}}}}};
  naxSend(unit,payload);
  (async()=>{let result=await naxHttpsRequest(unit,'POST','/Device',payload);if(naxNeedsLogin(result)){await naxRestLogin(unit);result=await naxHttpsRequest(unit,'POST','/Device',payload)}if(result.status<200||result.status>=300){unit.menuPending=false;unit.menuError='Media menu HTTP '+result.status;return}const navigation=result.json&&result.json.Device&&result.json.Device.MediaNavigation&&result.json.Device.MediaNavigation.RegisteredClientMenus;if(navigation&&navigation[unit.sessionId]){unit.menu=naxDeepMerge(unit.menu,navigation[unit.sessionId]);unit.menuPending=false;unit.menuUpdatedAt=Date.now();}})().catch(error=>{unit.menuPending=false;unit.menuError=error.message;});
}
function naxCurrentMenuName(unit){const updates=unit&&unit.menu&&unit.menu.MenuUpdates||{},requested=unit&&unit.menu&&unit.menu.LastRequestAction&&unit.menu.LastRequestAction.MenuCategory;return requested&&updates[requested]?requested:Object.keys(updates).slice(-1)[0]||'';}
function naxMenuItems(unit, requestedName) {
  const output=[], updates=unit&&unit.menu&&unit.menu.MenuUpdates||{}, menuName=requestedName||naxCurrentMenuName(unit), menu=updates[menuName]||{}, categories=menu&&menu.Categories||{};
  for (const category of Object.values(categories)) {
    const data=Array.isArray(category&&category.MenuDataItems)?category.MenuDataItems:[];
    if(!data.length&&category&&category.SubMenuCategory)output.push({id:String(output.length),name:category.DisplayMenuName||category.SubMenuCategory,icon:'',type:'dirmenu',artist:'',album:'',provider:'',browseKey:'',signedData:null,homeCategory:category.SubMenuCategory,menuName,playable:false});
    for (const item of data) {const signed=item&&item.SignedData||null,source=signed&&signed.SourceData||{},type=item.StreamingMediaType||'';output.push({id:String(output.length),name:item.BrowseItemName||item.FriendlyName||'Media',icon:item.UrlIcon||source.UrlIcon||'',type,artist:item.ArtistName||'',album:item.AlbumName||'',provider:item.MediaTypeMetaData&&item.MediaTypeMetaData.ProviderKey||source.ProviderKey||'',browseKey:item.BrowseKey||source.BrowseKey||'',signedData:signed,homeCategory:'',menuName,playable:!String(type).toLowerCase().includes('dir')&&!String(type).toLowerCase().includes('menu')});}
  }
  const seen=new Set();return output.filter(item=>{const key=String(item.provider||'')+'|'+String(item.browseKey||item.homeCategory||item.name||'');if(seen.has(key))return false;seen.add(key);return true}).slice(0,60);
}
function naxMenuPublic(unit) {
  const updates=unit&&unit.menu&&unit.menu.MenuUpdates||{},latest=naxCurrentMenuName(unit),current=updates[latest]||{},parent=current.ParentBrowseKey||{},loading=!!(unit&&unit.menuPending&&Date.now()-Number(unit.menuRequestedAt||0)<10000);
  const title=latest==='SearchMenu'?'Search results':latest==='ProviderBrowseMenu'?(parent.BrowseItemName||'Browse'):'My Music';
  const homeCategory=unit&&unit.menu&&unit.menu.LastRequestAction&&unit.menu.LastRequestAction.MenuCategoryOptions&&unit.menu.LastRequestAction.MenuCategoryOptions.HomeScreenCategory||'All';
  return {title,canBack:latest==='ProviderBrowseMenu'||latest==='SearchMenu'||(latest==='HomeScreenMenu'&&homeCategory!=='All'),loading,error:unit&&unit.menuError||'',items:naxMenuItems(unit,latest).map(({signedData,...item})=>item)};
}
function naxFavoriteRequest(unit,profileKey,item,name){
  if(!unit||!unit.sessionId)throw new Error('NAX Media Navigation is not connected');if(!item||!item.signedData)throw new Error('This item cannot be saved as a favorite');
  const favoriteName=String(name||item.name||'Favorite').trim().slice(0,80)||'Favorite';unit.pendingFavorites[profileKey]={name:favoriteName};unit.recentFavoriteData=unit.recentFavoriteData||{};unit.recentFavoriteData[profileKey]={name:favoriteName,signedData:item.signedData,until:Date.now()+120000};
  naxSend(unit,{Device:{MediaFavorites:{RequestAction:{RcSessionId:unit.sessionId,MsgId:naxUuidV1(),ProfileKey:profileKey,FavoritesAction:'AddFavorite',FavoritesActionOptions:{BrowseItemName:item.name||'Favorite',StreamingMediaType:item.type||'station',ArtistName:item.artist||'',AlbumName:item.album||'',ProviderSave:false,SignedData:item.signedData}}}}});
}
function naxDeleteFavorites(unit,device,profileKey,ids){const list=(ids||[]).map(String).filter(Boolean);if(!unit||!unit.sessionId)throw new Error('NAX Media Navigation is not connected');if(!list.length)return;const payload={Device:{MediaFavorites:{RequestAction:{RcSessionId:unit.sessionId,MsgId:naxUuidV1(),ProfileKey:profileKey,FavoritesAction:'DeleteFavorites',FavoritesActionOptions:{FavoriteIds:list}}}}};naxSend(unit,payload);unit.deletedFavoriteIds=unit.deletedFavoriteIds||{};for(const id of list)unit.deletedFavoriteIds[id]=Date.now()+30000;(async()=>{let result=await naxHttpsRequest(unit,'POST','/Device',payload);if(naxNeedsLogin(result)){await naxRestLogin(unit);result=await naxHttpsRequest(unit,'POST','/Device',payload)}if(result.status<200||result.status>=300)unit.restError='Delete favorites HTTP '+result.status})().catch(()=>{});const stored=unit.favorites&&unit.favorites[profileKey]&&unit.favorites[profileKey].Favorites;if(stored)for(const id of list)delete stored[id];naxRemoveCachedPresets(device,list);setTimeout(()=>naxListFavorites(unit,profileKey),1400);}
function naxFavoriteList(unit, allowCache = true) {
  const output = [];
  for (const [profile, profileData] of Object.entries(unit && unit.favorites || {})) {
    for (const [id, favorite] of Object.entries(profileData && profileData.Favorites || {})) {
      const item = favorite.MenuDataItems || favorite.MenuDataItem || {};
      const name=item.BrowseItemName||favorite.FriendlyName||'Preset',recent=unit&&unit.recentFavoriteData&&unit.recentFavoriteData[profile],recentSigned=recent&&Date.now()<Number(recent.until||0)&&String(recent.name||'').toLowerCase()===String(name).toLowerCase()?recent.signedData:null;output.push({ id, profile, name, browseKey:item.BrowseKey||'',type:item.StreamingMediaType||'station',icon: item.UrlIcon || '', provider: item.MediaTypeMetaData && item.MediaTypeMetaData.ProviderKey || '', signedData: item.SignedData || favorite.SignedData || recentSigned || null });
    }
  }
  if(output.length){if(!allowCache)return output.slice(0,8);return naxMergePresetCache(unit.device,output).slice(0,8);}
  if(unit&&unit.favoritesLoaded)return [];
  const cached=allowCache&&unit&&naxMediaCache[naxMediaCacheKey(unit.device)];
  return cached&&Array.isArray(cached.presets)?cached.presets.slice(0,8):[];
}
async function naxResolveFavoriteSignedData(unit,favorite){
  if(favorite&&favorite.signedData)return favorite.signedData;
  if(!unit||!favorite)throw new Error('NAX preset is unavailable');
  const profile=favorite.profile||'Profile1',started=Date.now();
  unit.menu={};
  naxMenuRequest(unit,profile,'SearchMenu',{SearchProviderKey:favorite.provider||'All',SearchText:favorite.name||'',SearchCategory:favorite.type||'station',ItemCount:50,ItemOffset:0});
  for(let attempt=0;attempt<70;attempt++){
    await new Promise(resolve=>setTimeout(resolve,100));
    if(Number(unit.menuUpdatedAt||0)<started||unit.menuPending)continue;
    const items=naxMenuItems(unit,'SearchMenu'),wantedKey=String(favorite.browseKey||''),wantedName=String(favorite.name||'').trim().toLowerCase();
    const item=items.find(value=>wantedKey&&String(value.browseKey||'')===wantedKey&&value.signedData)||items.find(value=>String(value.name||'').trim().toLowerCase()===wantedName&&value.signedData);
    if(item&&item.signedData){
      const stored=unit.favorites&&unit.favorites[profile]&&unit.favorites[profile].Favorites&&unit.favorites[profile].Favorites[favorite.id];
      if(stored){const menuItem=stored.MenuDataItems||stored.MenuDataItem||(stored.MenuDataItems={});menuItem.SignedData=item.signedData;}
      favorite.signedData=item.signedData;naxMergePresetCache(unit.device,[favorite]);return item.signedData;
    }
    if(!unit.menuPending&&items.length)break;
  }
  throw new Error('Preset source could not be refreshed from NAX');
}
function naxCookieHeader(unit) { return Object.entries(unit.cookies || {}).map(([key, value]) => key + '=' + value).join('; '); }
function naxSaveCookies(unit, headers) {
  for (const raw of headers['set-cookie'] || []) { const pair = raw.split(';', 1)[0], split = pair.indexOf('='); if (split > 0) unit.cookies[pair.slice(0, split)] = pair.slice(split + 1); }
  const token = headers['crest-xsrf-token']; if (token) unit.xsrf = Array.isArray(token) ? token[0] : token;
}
function naxHttpsRequest(unit, method, requestPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const host = String(unit.device.naxHost || '').trim();
    const rawBody = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const data = rawBody == null ? null : Buffer.from(rawBody);
    const headers = { Accept: 'application/json', Host: host, Referer: 'https://' + host + '/', Connection: 'close', ...extraHeaders };
    const cookies = naxCookieHeader(unit); if (cookies) headers.Cookie = cookies;
    if (data) { headers['Content-Type'] = extraHeaders['Content-Type'] || 'application/json'; headers['Content-Length'] = data.length; }
    if (method === 'POST' && unit.xsrf) headers['X-CREST-XSRF-TOKEN'] = unit.xsrf;
    const request = https.request({ hostname: host, port: 443, path: requestPath, method, headers, rejectUnauthorized: false, agent: false }, response => {
      naxSaveCookies(unit, response.headers);
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : {}; } catch (_) {} resolve({ status: response.statusCode, json, text, headers: response.headers, redirect: response.headers.location || '' }); });
    });
    request.setTimeout(6500, () => request.destroy(new Error('NAX REST timeout'))); request.on('error', reject); if (data) request.write(data); request.end();
  });
}
function naxNeedsLogin(result) { return !!(result && result.redirect && String(result.redirect).toLowerCase().includes('userlogin')) || [401, 403, 511].includes(Number(result && result.status)); }
async function naxRestLogin(unit) {
  const username = String(unit.device.naxRestUsername || ''), password = String(unit.device.naxRestPassword || '');
  if (!username && !password) { unit.restAuth = 'required'; throw new Error('NAX REST username and password required'); }
  unit.cookies = {}; unit.xsrf = '';
  await naxHttpsRequest(unit, 'GET', '/userlogin.html');
  const form = 'login=' + encodeURIComponent(username) + '&&passwd=' + encodeURIComponent(password);
  const result = await naxHttpsRequest(unit, 'POST', '/userlogin.html', form, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://' + String(unit.device.naxHost || '').trim(), Referer: 'https://' + String(unit.device.naxHost || '').trim() + '/userlogin.html' });
  if (result.status === 200 || (result.status === 302 && result.redirect === '/')) { unit.restAuth = 'ok'; unit.restRetryAt = 0; return; }
  const blocked = /account is blocked/i.test(String(result.text || ''));
  unit.restAuth = blocked ? 'blocked' : 'failed'; unit.restRetryAt = Date.now() + (blocked ? 10 * 60 * 1000 : 60 * 1000);
  throw new Error(blocked ? 'NAX REST account is blocked' : 'NAX REST login failed (HTTP ' + result.status + ')');
}
function naxExtractChannels(json) {
  const direct=json&&json.Device&&json.Device.OutputChannels&&json.Device.OutputChannels.Channels;
  if(direct&&typeof direct==='object'&&Object.keys(direct).length)return direct;
  const zones=json&&json.Device&&json.Device.ZoneOutputs&&json.Device.ZoneOutputs.Zones;
  if(zones&&typeof zones==='object')return Object.fromEntries(Object.entries(zones).map(([id,zone])=>[id,{...(zone||{}),...((zone&&zone.ZoneAudio)||{}),_kind:'zone'}]));
  let found={};function walk(value,key){if(!value||typeof value!=='object')return;if(key==='Channels'&&!Array.isArray(value)&&Object.values(value).some(item=>item&&typeof item==='object'&&('Volume'in item||'IsMuted'in item)))found=value;for(const[childKey,child]of Object.entries(value))walk(child,childKey)}walk(json,'');return found;
}
async function naxGetRestObject(unit,requestPath){let result=await naxHttpsRequest(unit,'GET',requestPath);if(naxNeedsLogin(result)){await naxRestLogin(unit);result=await naxHttpsRequest(unit,'GET',requestPath)}return result;}
async function naxRefreshVolume(unit) {
  let result=await naxGetRestObject(unit,'/Device/OutputChannels/'),channels=result.status===200&&result.json?naxExtractChannels(result.json):{};
  if(!Object.keys(channels).length){result=await naxGetRestObject(unit,'/Device/ZoneOutputs/');channels=result.status===200&&result.json?naxExtractChannels(result.json):{};}
  if(result.status!==200||!result.json)throw new Error('NAX volume HTTP '+result.status);
  unit.channels=channels;unit.restError='';unit.restAuth='ok';
}
async function naxRefreshRouting(unit) {
  const [inputsResult, routesResult] = await Promise.all([
    naxGetRestObject(unit, '/Device/InputSources/'),
    naxGetRestObject(unit, '/Device/AvMatrixRouting/')
  ]);
  unit.inputSources = inputsResult.json && inputsResult.json.Device && inputsResult.json.Device.InputSources && inputsResult.json.Device.InputSources.Inputs || {};
  unit.avRoutes = routesResult.json && routesResult.json.Device && routesResult.json.Device.AvMatrixRouting && routesResult.json.Device.AvMatrixRouting.Routes || {};
}
async function naxRefreshRouting(unit){
  const inputsResult=await naxGetRestObject(unit,'/Device/InputSources/');
  const routesResult=await naxGetRestObject(unit,'/Device/AvMatrixRouting/');
  unit.inputSources=inputsResult.json&&inputsResult.json.Device&&inputsResult.json.Device.InputSources&&inputsResult.json.Device.InputSources.Inputs||{};
  unit.avRoutes=routesResult.json&&routesResult.json.Device&&routesResult.json.Device.AvMatrixRouting&&routesResult.json.Device.AvMatrixRouting.Routes||{};
}
async function naxRefreshMediaRest(unit){
  const profilesResult=await naxGetRestObject(unit,'/Device/StreamingServices/UserProfiles/');
  const profiles=profilesResult.json&&profilesResult.json.Device&&profilesResult.json.Device.StreamingServices&&profilesResult.json.Device.StreamingServices.UserProfiles;if(profiles)unit.userProfiles=naxDeepMerge(unit.userProfiles,profiles);
  const playersResult=await naxGetRestObject(unit,'/Device/MediaPlayerNeXt/Players/');
  const players=playersResult.json&&playersResult.json.Device&&playersResult.json.Device.MediaPlayerNeXt&&playersResult.json.Device.MediaPlayerNeXt.Players;if(players)unit.players=naxDeepMerge(unit.players,players);
  const favoritesResult=await naxGetRestObject(unit,'/Device/MediaFavorites/');
  const favorites=favoritesResult.json&&favoritesResult.json.Device&&favoritesResult.json.Device.MediaFavorites&&favoritesResult.json.Device.MediaFavorites.Profiles;if(favorites){naxApplyFavorites(unit,favorites);const received=naxFavoriteList(unit,false);if(received.length)naxMergePresetCache(unit.device,received);}
}
function naxChannelForPlayer(unit, device, playerNumber) {
  const channels = unit && unit.channels || {}, keys = Object.keys(channels).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const explicit = String(device['naxOutput' + naxPlayerNumber(playerNumber)] || '').trim();
  if (explicit && channels[explicit]) return explicit;
  const mapping = naxPlayerMappings(device).find(item => item.number === naxPlayerNumber(playerNumber));
  const room = String(mapping && mapping.room || '').trim().toLowerCase();
  if (room) {
    const named = keys.find(key => String(channels[key] && channels[key].Name || '').trim().toLowerCase() === room);
    if (named) return named;
  }
  const routed = keys.find(key => {
    const value=channels[key] || {}, needle=naxPlayerIdForNumber(playerNumber).toLowerCase();
    return [value.Source,value.SourceId,value.AudioSource,value.InputSource,value.Name].some(item=>String(item||'').toLowerCase().includes(needle));
  });
  if (routed) return routed;
  if (keys[naxPlayerNumber(playerNumber)-1]) return keys[naxPlayerNumber(playerNumber)-1];
  const configuredRooms=readDashboardState().rooms||[], roomIndex=configuredRooms.findIndex(value=>String(value||'').trim().toLowerCase()===room);
  if (roomIndex>=0 && roomIndex<4) return 'Zone'+String(roomIndex+1);
  return '';
}
function naxInputForPlayer(unit, playerNumber) {
  const number=naxPlayerNumber(playerNumber),inputs=unit&&unit.inputSources||{},entries=Object.entries(inputs);
  const named=entries.find(([,value])=>String(value&&value.Name||'').trim().toLowerCase()==='mediastream'+number);
  if(named)return named[0];
  const media=entries.filter(([,value])=>String(value&&value.AudioType||'').toLowerCase()==='mediaplayer').sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}));
  return media[number-1]&&media[number-1][0]||'';
}
async function naxRoutePlayerToOutput(unit,device,playerNumber){
  if(!unit)throw new Error('NAX unit is not connected');
  if(!Object.keys(unit.channels||{}).length||!Object.keys(unit.inputSources||{}).length||!Object.keys(unit.avRoutes||{}).length){await naxRefreshVolume(unit);await naxRefreshRouting(unit);}
  const channel=naxChannelForPlayer(unit,device,playerNumber),source=naxInputForPlayer(unit,playerNumber);
  if(!channel)throw new Error('No NAX output channel is available for this player');
  if(!source)throw new Error('No NAX media input is available for this player');
  if(String(unit.avRoutes[channel]&&unit.avRoutes[channel].AudioSource||'')===source)return {channel,source};
  const payload={Device:{AvMatrixRouting:{Routes:{[channel]:{AudioSource:source}}}}};
  let result=await naxHttpsRequest(unit,'POST','/Device',payload);
  if(naxNeedsLogin(result)){await naxRestLogin(unit);result=await naxHttpsRequest(unit,'POST','/Device',payload);}
  if(result.status<200||result.status>=300)throw new Error('NAX source routing HTTP '+result.status);
  unit.avRoutes[channel]={...(unit.avRoutes[channel]||{}),AudioSource:source};
  return {channel,source};
}async function naxSetVolume(unit, device, playerNumber, volumePercent) {
  if (!Object.keys(unit.channels || {}).length && Date.now() >= Number(unit.restRetryAt || 0)) { try { await naxRefreshVolume(unit); } catch (_) {} }
  const channel = naxChannelForPlayer(unit, device, playerNumber);
  if (!channel) throw new Error('No NAX output channel is available. Select an output for this player in Settings.');
  const value = Math.max(0, Math.min(1000, Math.round(Number(volumePercent) * 10)));
  const channelState=unit.channels[channel]||{},payload=channelState._kind==='zone'||/^Zone/i.test(channel)?{Device:{ZoneOutputs:{Zones:{[channel]:{ZoneAudio:{Volume:value}}}}}}:{Device:{OutputChannels:{Channels:{[channel]:{Volume:value}}}}};
  let result = await naxHttpsRequest(unit, 'POST', '/Device', payload);
  if (naxNeedsLogin(result)) { await naxRestLogin(unit); result = await naxHttpsRequest(unit, 'POST', '/Device', payload); }
  if (result.status < 200 || result.status >= 300) throw new Error('NAX volume HTTP ' + result.status);
  unit.pendingVolumes = unit.pendingVolumes || {};
  unit.pendingVolumes[channel] = { value, until: Date.now() + 15000 };
  return Math.round(value / 10);
}
function naxFetchImage(resourceUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed; try { parsed = new URL(resourceUrl); } catch (_) { return reject(new Error('Invalid NAX image URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('NAX image protocol rejected'));
    const library = parsed.protocol === 'https:' ? https : http;
    const request = library.get(parsed, { rejectUnauthorized: false, timeout: 6000, headers: { 'User-Agent': 'HtmlUI/3.1' } }, response => {
      if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location && redirects < 3) { response.resume(); const target = new URL(response.headers.location, parsed).toString(); return naxFetchImage(target, redirects + 1).then(resolve, reject); }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); return reject(new Error('NAX image HTTP ' + response.statusCode)); }
      const chunks = []; let length = 0; response.on('data', chunk => { length += chunk.length; if (length <= 2 * 1024 * 1024) chunks.push(chunk); else request.destroy(new Error('NAX image is too large')); }); response.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: response.headers['content-type'] || 'image/png' }));
    }); request.on('error', reject);
  });
}
function naxPublicPlayerState(device, playerNumber) {
  const unit=naxUnits.get(naxUnitKey(device)), playerId=naxPlayerIdForNumber(playerNumber), player=unit && unit.players[playerId] || {};
  const channel=unit ? naxChannelForPlayer(unit,device,playerNumber) : '', channelState=unit && unit.channels[channel] || {};
  let rawVolume=channelState.Volume,pending=unit&&unit.pendingVolumes&&unit.pendingVolumes[channel];
  if(pending){if(Number.isFinite(Number(rawVolume))&&Math.abs(Number(rawVolume)-Number(pending.value))<=1)delete unit.pendingVolumes[channel];else if(Date.now()<Number(pending.until||0))rawVolume=pending.value;else delete unit.pendingVolumes[channel];}
  return { connected:!!(unit&&unit.connected), socketOpen:!!(unit&&unit.socketOpen), error:unit&&(unit.error||unit.restError)||'', restAuth:unit&&unit.restAuth||'unknown', playerId, player, availableActions:naxAvailableActions(player), presets:naxFavoriteList(unit).map(item=>({id:item.id,name:item.name,icon:item.icon,provider:item.provider,playable:!!item.signedData})), volume:Number.isFinite(Number(rawVolume))?Math.round(Number(rawVolume)/10):null, muted:!!channelState.IsMuted, outputChannel:channel, outputs:Object.entries(unit&&unit.channels||{}).map(([id,value])=>({id,name:value&&value.Name||id,signal:!!(value&&value.IsSignalDetected)})), routing:{inputs:Object.fromEntries(Object.entries(unit&&unit.inputSources||{}).map(([id,value])=>[id,{name:value&&value.Name||id,type:value&&value.AudioType||'',signal:!!(value&&value.IsSignalPresent)}])),routes:Object.fromEntries(Object.entries(unit&&unit.avRoutes||{}).map(([id,value])=>[id,{audioSource:value&&value.AudioSource||''}]))}, menu:naxMenuPublic(unit), updatedAt:unit&&unit.updatedAt||'' };
}
async function naxMonitor() {
  naxReconcile();
  const now = Date.now();
  for (const unit of naxUnits.values()) if (now >= Number(unit.nextRest || 0)) { unit.nextRest = now + 7000; if (now < Number(unit.restRetryAt || 0)) continue; try{await naxRefreshVolume(unit);await naxRefreshRouting(unit);await naxRefreshMediaRest(unit);unit.restError='';const missing=naxFavoriteList(unit,false).find(item=>!item.signedData);if(missing&&!unit.presetResolveInFlight){unit.presetResolveInFlight=true;naxResolveFavoriteSignedData(unit,missing).catch(()=>{}).finally(()=>{unit.presetResolveInFlight=false;});}}catch(error){unit.restError=error.message;} }
}
setInterval(naxMonitor, 2500); setTimeout(naxMonitor, 900);

function status(ok, message) {
  connected = ok;
  if (ok) lastKnxActivityAt = Date.now();
  console.log(`[KNX] ${message}`);
  broadcast({ type: "knx-status", connected: ok, message });
}

function feedbackAddresses(connection) {
  const values = [
    ...(Array.isArray(connection.feedbackGAs) ? connection.feedbackGAs : []),
    connection.feedbackGa,
    ...(Array.isArray(connection.switchFeedbackGAs) ? connection.switchFeedbackGAs : []),
    ...(Array.isArray(connection.securityFeedbackGAs) ? connection.securityFeedbackGAs : []),
    ...(Array.isArray(connection.cameraFeedbackGAs) ? connection.cameraFeedbackGAs : [])
  ];
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function refreshKNXFeedbackSubscriptions(nextConfig) {
  config = {
    ...config,
    feedbackGAs: Array.isArray(nextConfig.feedbackGAs) ? nextConfig.feedbackGAs : [],
    switchFeedbackGAs: Array.isArray(nextConfig.switchFeedbackGAs) ? nextConfig.switchFeedbackGAs : [],
    securityFeedbackGAs: Array.isArray(nextConfig.securityFeedbackGAs) ? nextConfig.securityFeedbackGAs : [],
    cameraFeedbackGAs: Array.isArray(nextConfig.cameraFeedbackGAs) ? nextConfig.cameraFeedbackGAs : []
  };
  persistKNXConnection(config, true);
  if (!knx || !connected) return;
  for (const ga of feedbackAddresses(config)) {
    try { knx.read(ga); } catch (_) {}
  }
}
function connectKNX(newConfig) {
  if (knx) {
    try { knx.Disconnect(); } catch (_) {}
    knx = null;
  }

  config = { ...DEFAULT, ...newConfig };

  console.log(`[KNX] Verbinden met ${config.ip}:${config.port} via ${config.mode}`);

  const options = {
    hostProtocol: config.mode,
    ipAddr: config.ip,
    ipPort: Number(config.port),
    physAddr: config.physAddr,
    loglevel: "info",
    autoReconnect: true
  };

  knx = new KNXClient(options);

  knx.on("connected", () => {
    persistKNXConnection(config, true);
    status(true, `KNX verbonden met ${config.ip}:${config.port}`);
    const securityFeedbackGAs = Array.isArray(config.securityFeedbackGAs) ? config.securityFeedbackGAs : [];
    const cameraFeedbackGAs = Array.isArray(config.cameraFeedbackGAs) ? config.cameraFeedbackGAs : [];
    const gas = Array.from(new Set([
      ...(Array.isArray(config.feedbackGAs) ? config.feedbackGAs : []),
      config.feedbackGa,
      ...securityFeedbackGAs,
      ...cameraFeedbackGAs
    ].filter(Boolean)));
    for (const ga of gas) {
      try {
        knx.read(ga);
        console.log(`[KNX] READ feedback ${ga}`);
      } catch (e) {
        console.error(`[KNX] READ ${ga}:`, e.message);
      }
    }
  });

  knx.on("disconnected", reason => {
    status(false, `KNX verbinding verbroken${reason ? ": " + reason : ""}`);
  });

  knx.on("error", err => {
    status(false, "KNX fout: " + err.message);
  });

  knx.on("indication", packet => {
    try {
      lastKnxActivityAt = Date.now();
      if (!connected) status(true, "KNX communication active");
      const cemi = packet?.cEMIMessage;
      if (!cemi?.npdu) return;

      const ga = cemi.dstAddress?.toString?.();
      const normGA = v => String(v || '').trim().replace(/\s+/g, '');
      const feedbackGAs = new Set([
        ...(Array.isArray(config.feedbackGAs) ? config.feedbackGAs : []),
        config.feedbackGa
      ].filter(Boolean).map(normGA));
      const switchFeedbackGAs = new Set((Array.isArray(config.switchFeedbackGAs) ? config.switchFeedbackGAs : []).filter(Boolean).map(normGA));
      const securityFeedbackGAs = new Set((Array.isArray(config.securityFeedbackGAs) ? config.securityFeedbackGAs : []).filter(Boolean).map(normGA));
      const cameraFeedbackGAs = new Set((Array.isArray(config.cameraFeedbackGAs) ? config.cameraFeedbackGAs : []).filter(Boolean).map(normGA));
      if (!ga || (!feedbackGAs.has(normGA(ga)) && !switchFeedbackGAs.has(normGA(ga)) && !securityFeedbackGAs.has(normGA(ga)) && !cameraFeedbackGAs.has(normGA(ga)))) return;

      const npdu = cemi.npdu;
      if (!(npdu.isGroupWrite || npdu.isGroupResponse)) return;
      const raw = npdu.dataValue;
      if (!raw || !dptlib) return;

      if (cameraFeedbackGAs.has(normGA(ga))) {
        const dpt = dptlib.resolve("1.001");
        const value = !!dptlib.fromBuffer(raw, dpt);
        broadcast({ type: "camera-feedback", ga, value });
        console.log(`[KNX] CAMERA FEEDBACK ${ga} = ${value}`);
        return;
      }

      if (switchFeedbackGAs.has(normGA(ga))) {
        const dpt = dptlib.resolve("1.001");
        const value = !!dptlib.fromBuffer(raw, dpt);
        broadcast({ type: "feedback", ga, value: value ? 1 : 0 });
        console.log("[KNX] SWITCH FEEDBACK " + ga + " = " + (value ? "ON" : "OFF"));
        return;
      }

      if (securityFeedbackGAs.has(normGA(ga))) {
        const dpt = dptlib.resolve("1.001");
        const value = !!dptlib.fromBuffer(raw, dpt);
        broadcast({ type: "security-feedback", ga, value });
        console.log(`[KNX] SECURITY FEEDBACK ${ga} = ${value}`);
        return;
      }

      const dpt = dptlib.resolve("5.001");
      const value = dptlib.fromBuffer(raw, dpt);
      broadcast({ type: "feedback", ga, value: Number(value) });
      console.log(`[KNX] FEEDBACK ${ga} = ${value}%`);
    } catch (err) {
      console.error("[KNX] Feedback decode:", err.message);
    }
  });

  knx.Connect();
}

function writeKNX(ga, dpt, value) {
  if (!knx || !connected) {
    throw new Error("KNX is niet verbonden");
  }
  const v = Math.max(0, Math.min(100, Number(value)));
  knx.write(ga, v, dpt);
  console.log(`[KNX] WRITE ${ga} ${dpt} ${v}%`);
}

function writeRGBW(channels) {
  if (!knx || !connected) throw new Error("KNX is niet verbonden");
  if (!Array.isArray(channels)) throw new Error("Ongeldige RGBW-kanalen");
  for (const ch of channels) {
    if (!ch || !/^\d{1,3}\/\d{1,3}\/\d{1,3}$/.test(String(ch.ga || '').trim())) continue;
    const v = Math.max(0, Math.min(100, Number(ch.value)));
    const dpt = /^\d{1,3}(?:\.\d{1,3})?$/.test(String(ch.dpt || '')) ? String(ch.dpt) : '5.001';
    knx.write(String(ch.ga).trim(), v, dpt);
    console.log(`[KNX] RGBW WRITE ${String(ch.ga).trim()} ${dpt} ${v}%`);
  }
}

const server = http.createServer((req, res) => {
  const requestPath = (req.url || "/").split("?")[0];

  const dynamicCameraMatch = requestPath === "/camera/stream.mjpg" ? true : false;
  if (dynamicCameraMatch && req.method === "GET") {
    const query = new URL(req.url, "http://localhost").searchParams;
    const rtspUrl = query.get("url") || "";
    return streamRtspUrl(req, res, rtspUrl);
  }

  const camMatch = requestPath.match(/^\/camera\/(\d+)\.mjpg$/);
  if (camMatch && req.method === "GET") {
    return streamCamera(req, res, Number(camMatch[1]));
  }
  const configuredCamMatch = requestPath.match(/^\/camera\/configured\/(.+)\.mjpg$/);
  if (configuredCamMatch && req.method === "GET") {
    return streamConfiguredCamera(req, res, configuredCamMatch[1]);
  }
  if (requestPath === "/camera.mjpg" && req.method === "GET") {
    return streamCamera(req, res, 0);
  }

  const cameraHealthMatch = requestPath.match(/^\/api\/camera\/([^/]+)\/test$/);
  if (cameraHealthMatch && req.method === "GET") {
    let id = '';
    try { id = decodeURIComponent(cameraHealthMatch[1]); } catch (_) {}
    let state = {};
    try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) {}
    const devices = Array.isArray(state.genericDevices) ? state.genericDevices : [];
    const camera = devices.find(x => String(x.id || '') === id && x.type === 'camera');
    if (!camera) { res.writeHead(404, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:false,error:"Camera not found"})); }
    const url = String(camera.url || '');
    if (!/^rtsps?:\/\//i.test(url)) { res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:true,type:"http",url})); }
    const candidates=ffmpegCandidates();
    let probe=null,idx=0,err='';
    const runProbe=()=>{
      const bin=candidates[idx++];
      if(!bin){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"FFmpeg not available. Run npm install or set FFMPEG_PATH."}));}
      err='';
      probe=spawn(bin,["-hide_banner","-loglevel","error","-rtsp_transport","tcp","-i",url,"-t","1","-f","null","-"],{windowsHide:true});
      probe.stderr.on('data',d=>{err+=String(d)});
      probe.on('close',code=>{
        if(code===0){res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});return res.end(JSON.stringify({ok:true}));}
        if(idx<candidates.length)return runProbe();
        res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:err.trim().slice(-800)||'FFmpeg could not open the RTSP stream'}));
      });
      probe.on('error',e=>{err=e.message;if(idx<candidates.length)return runProbe();res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:err}));});
    };
    runProbe();
    return;
  }

  if (requestPath === "/api/av/status" && req.method === "GET") {
    const statuses = {};
    for (const [id, value] of avStatuses.entries()) statuses[id] = value;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ statuses }));
  }

  const avAppsMatch = requestPath.match(/^\/api\/av\/([^/]+)\/apps$/);
  if (avAppsMatch && req.method === "GET") {
    let id = '';
    try { id = decodeURIComponent(avAppsMatch[1]); } catch (_) {}
    const cachedOnly = new URL(req.url, 'http://localhost').searchParams.get('cached') === '1';
    const existing = avAppsCache.get(id);
    if (cachedOnly && existing && Array.isArray(existing.apps) && existing.apps.length) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ cached: true, apps: existing.apps.slice(0, 4).map((app, index) => ({ id: app.id, title: app.title, iconUrl: app.icon ? '/api/av/' + encodeURIComponent(id) + '/app-icon/' + index : '' })) }));
      return;
    }
    (async () => {
      try {
        const tv = configuredTvById(id);
        if (!tv) throw new Error('Configured LG TV not found');
        const result = await lgWebosRequest(tv, 'ssap://com.webos.applicationManager/listLaunchPoints', {}, { allowPairing: true, timeoutMs: 45000 });
        const launchPoints = Array.isArray(result.launchPoints) ? result.launchPoints : [];
        const apps = launchPoints.slice(0, 4).map((app, index) => {
          let icon = String(app.icon || app.largeIcon || app.mediumLargeIcon || '');
          if (icon && !/^https?:\/\//i.test(icon)) icon = 'https://' + String(tv.ipAddress).trim() + ':3001' + (icon.startsWith('/') ? '' : '/') + icon;
          return { id: String(app.id || app.launchPointId || ''), title: String(app.title || app.name || 'App ' + (index + 1)), icon };
        });
        avAppsCache.set(id, { tvIp: String(tv.ipAddress || '').trim(), apps, updatedAt: Date.now() });
        saveWebosAppsCache();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ apps: apps.map((app, index) => ({ id: app.id, title: app.title, iconUrl: app.icon ? '/api/av/' + encodeURIComponent(id) + '/app-icon/' + index : '' })) }));
      } catch (error) {
        const cached = avAppsCache.get(id);
        if (cached && Array.isArray(cached.apps) && cached.apps.length) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ cached: true, warning: error.message, apps: cached.apps.slice(0, 4).map((app, index) => ({ id: app.id, title: app.title, iconUrl: app.icon ? '/api/av/' + encodeURIComponent(id) + '/app-icon/' + index : '' })) }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      }
    })();
    return;
  }

  const avIconMatch = requestPath.match(/^\/api\/av\/([^/]+)\/app-icon\/(\d+)$/);
  if (avIconMatch && req.method === "GET") {
    let id = '';
    try { id = decodeURIComponent(avIconMatch[1]); } catch (_) {}
    const cached = avAppsCache.get(id);
    const index = Number(avIconMatch[2]);
    const app = cached && cached.apps[index];
    if (!cached || !app || !app.icon) { res.writeHead(404); return res.end('App icon not found'); }
    fetchTvResource(app.icon, cached.tvIp).then(result => {
      res.writeHead(200, { "Content-Type": result.contentType, "Cache-Control": "private, max-age=300" });
      res.end(result.data);
    }).catch(error => {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error.message);
    });
    return;
  }
  const avLaunchMatch = requestPath.match(/^\/api\/av\/([^/]+)\/apps\/launch$/);
  if (avLaunchMatch && req.method === "POST") {
    let id = '';
    try { id = decodeURIComponent(avLaunchMatch[1]); } catch (_) {}
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        const appId = String(input.appId || '').trim();
        if (!appId || appId.length > 240 || /[\u0000-\u001f]/.test(appId)) throw new Error('Invalid webOS app id');
        const tv = configuredTvById(id);
        if (!tv) throw new Error('Configured LG TV not found');
        let power = await getLgWebosPowerStatus(tv);
        let wokeTv = false;
        if (!power.online) {
          await sendWakeOnLan(tv.macAddress);
          wokeTv = true;
          const deadline = Date.now() + 35000;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            power = await getLgWebosPowerStatus(tv);
            if (power.online) break;
          }
          if (!power.online) throw new Error('TV did not become ready after Wake-on-LAN');
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        await lgWebosRequest(tv, 'ssap://system.launcher/launch', { id: appId }, { allowPairing: true, timeoutMs: 12000 });
        avNextChecks.set(id, 0);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, wokeTv, message: wokeTv ? 'TV started and app opened' : 'App opened on LG TV' }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }

  const avPowerMatch = requestPath.match(/^\/api\/av\/([^/]+)\/power$/);
  if (avPowerMatch && req.method === "POST") {
    let id = '';
    try { id = decodeURIComponent(avPowerMatch[1]); } catch (_) {}
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        const action = input.action === 'off' ? 'off' : 'on';
        const state = readDashboardState();
        const devices = Array.isArray(state.genericDevices) ? state.genericDevices : [];
        const tv = devices.find(device => String(device.id || '') === id && device.type === 'av' && (!device.avType || device.avType === 'tv'));
        if (!tv) throw new Error('Configured TV not found');
        if (String(tv.tvModelType || 'lg-webos') !== 'lg-webos') throw new Error('Unsupported TV type');
        if (action === 'on') {
          await sendWakeOnLan(tv.macAddress);
        } else {
          await lgWebosTurnOff(tv);
        }
        avNextChecks.set(id, 0);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, message: action === 'on' ? 'LG TV Wake-on-LAN command sent' : 'LG webOS TV Off command sent' }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }
  const avVolumeMatch = requestPath.match(/^\/api\/av\/([^/]+)\/volume$/);
  if (avVolumeMatch && req.method === "POST") {
    let id = '';
    try { id = decodeURIComponent(avVolumeMatch[1]); } catch (_) {}
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        const action = input.action === 'down' ? 'down' : input.action === 'up' ? 'up' : '';
        const requested=Number(input.volume),hasRequested=Number.isFinite(requested),target=Math.max(0,Math.min(100,Math.round(requested)));
        if (!action&&!hasRequested) throw new Error('Invalid volume action');
        const tv = configuredTvById(id);
        if (!tv) throw new Error('Configured LG TV not found');
        const previous = avStatuses.get(id) || {};
        if(previous.online!==true){const power=await getLgWebosPowerStatus(tv);if(!power.online)throw new Error('TV is off');}
        if(hasRequested)await lgWebosRequest(tv,'ssap://audio/setVolume',{volume:target},{timeoutMs:3500});else await lgWebosRequest(tv,action==='up'?'ssap://audio/volumeUp':'ssap://audio/volumeDown',{}, {timeoutMs:3500});
        const volume=hasRequested?target:Math.max(0,Math.min(100,Number(previous.volume||0)+(action==='down'?-1:1)));
        const status = { ...previous, online: true, powerState: previous.powerState || 'Active', error: '', checkedAt: new Date().toISOString(), ipAddress: String(tv.ipAddress || '').trim(), volume, muted: !!previous.muted };
        avStatuses.set(id, status);
        broadcast({ type: 'av-status', id, status });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, volume: status.volume, muted: status.muted }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }
  if (requestPath === "/api/nax/status" && req.method === "GET") {
    naxReconcile(); const devices={};
    for (const device of naxDevices()) for (const mapping of naxPlayerMappings(device)) devices[String(device.id||'')+'::'+mapping.number]=naxPublicPlayerState(device,mapping.number);
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); return res.end(JSON.stringify({devices}));
  }
  const naxActionMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/action$/);
  if(naxActionMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxActionMatch[1])}catch(_){} let body='';req.on('data',c=>{body+=c;if(body.length>20000)req.destroy()});req.on('end',async()=>{try{
      const input=JSON.parse(body||'{}'), allowed=new Set(['Play','Pause','Stop','NextTrack','PreviousTrack','Ffwd','Rewind','Shuffle','Repeat','ThumbsUp','ThumbsDown']), target=naxResolveTarget(id); if(!target)throw new Error('Configured NAX player not found'); if(!allowed.has(input.action))throw new Error('NAX action is not allowed');
      const options=input.action==='Shuffle'?{ShufState:!!input.enabled}:input.action==='Repeat'?{RepState:Math.max(0,Math.min(2,Number(input.mode)||0))}:{};
      const unit=naxUnits.get(naxUnitKey(target.device));if(input.action==='Play')await naxRoutePlayerToOutput(unit,target.device,target.number);
      naxPlayerAction(naxUnits.get(naxUnitKey(target.device)),naxPlayerIdForNumber(target.number),input.action,options);res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));
    }catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}});return;
  }
  const naxVolumeMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/volume$/);
  if(naxVolumeMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxVolumeMatch[1])}catch(_){} let body='';req.on('data',c=>{body+=c;if(body.length>20000)req.destroy()});req.on('end',async()=>{try{
      const input=JSON.parse(body||'{}'),target=naxResolveTarget(id);if(!target)throw new Error('Configured NAX player not found');const unit=naxUnits.get(naxUnitKey(target.device));if(!unit)throw new Error('NAX unit is not connected');const current=naxPublicPlayerState(target.device,target.number).volume,requested=Number.isFinite(Number(input.volume))?Number(input.volume):Math.max(0,Math.min(100,Number(current||0)+(input.action==='down'?-2:2))),volume=await naxSetVolume(unit,target.device,target.number,requested);res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true,volume}));
    }catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}});return;
  }
  const naxPresetMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/preset$/);
  if(naxPresetMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxPresetMatch[1])}catch(_){} let body='';req.on('data',c=>{body+=c;if(body.length>20000)req.destroy()});req.on('end',async()=>{try{
      const input=JSON.parse(body||'{}'),target=naxResolveTarget(id);if(!target)throw new Error('Configured NAX player not found');const unit=naxUnits.get(naxUnitKey(target.device)),favorites=naxFavoriteList(unit,false),favorite=favorites.find(item=>String(item.id)===String(input.presetId||''))||favorites.find(item=>String(item.name||'').toLowerCase()===String(input.presetName||'').toLowerCase());if(!favorite)throw new Error('NAX preset is no longer available');const signedData=await naxResolveFavoriteSignedData(unit,favorite),source=signedData.SourceData||{};const playerId=naxPlayerIdForNumber(target.number);await naxRoutePlayerToOutput(unit,target.device,target.number);naxPlayerAction(unit,playerId,'LoadSource',{ProfileKey:source.ProfileKey||favorite.profile,ProviderKey:source.ProviderKey||favorite.provider||'',AutoPlay:true,SignedData:signedData});[900,2500].forEach(delay=>setTimeout(()=>{try{naxPlayerAction(unit,playerId,'Play')}catch(_){}},delay));res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));
    }catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}});return;
  }
  const naxMenuMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/menu$/);
  if(naxMenuMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxMenuMatch[1])}catch(_){} let body='';req.on('data',c=>{body+=c;if(body.length>100000)req.destroy()});req.on('end',async()=>{try{
      const input=JSON.parse(body||'{}'),target=naxResolveTarget(id);if(!target)throw new Error('Configured NAX player not found');const unit=naxUnits.get(naxUnitKey(target.device));if(!unit)throw new Error('NAX unit is not connected');const profile=naxProfileForPlayer(unit,target.number),history=unit.menuHistory[target.virtualId]||(unit.menuHistory[target.virtualId]=[]);
      const browseItem=item=>{const source=item&&item.signedData&&item.signedData.SourceData||{};naxMenuRequest(unit,source.ProfileKey||profile,'ProviderBrowseMenu',{ProviderKey:source.ProviderKey||item.provider||'',BrowseKey:source.BrowseKey||item.browseKey||'',ItemCount:24,ItemOffset:0,SignedData:item.signedData});};
      if(input.action==='home'){history.length=0;unit.menu={};naxMenuRequest(unit,profile,'HomeScreenMenu',{HomeScreenCategory:'All',ItemCount:50,ItemOffset:0});}
      else if(input.action==='search'){const query=String(input.query||'').trim();if(!query)throw new Error('Enter a station or artist');history.length=0;unit.menu={};naxMenuRequest(unit,profile,'SearchMenu',{SearchProviderKey:'All',SearchText:query,SearchCategory:String(input.category||'station'),ItemCount:24,ItemOffset:0});}
      else if(input.action==='back'){history.pop();unit.menu={};if(history.length)browseItem(history[history.length-1]);else naxMenuRequest(unit,profile,'HomeScreenMenu',{HomeScreenCategory:'All',ItemCount:50,ItemOffset:0});}
      else if(input.action==='select'){const item=naxMenuItems(unit).find(entry=>String(entry.id)===String(input.itemId));if(!item)throw new Error('NAX menu item not found');if(item.homeCategory){unit.menu={};naxMenuRequest(unit,profile,'HomeScreenMenu',{HomeScreenCategory:item.homeCategory,ItemCount:50,ItemOffset:0});}else if(!item.signedData)throw new Error('This menu item is unavailable');else if(!item.playable){history.push(item);unit.menu={};browseItem(item)}else{const source=item.signedData.SourceData||{};await naxRoutePlayerToOutput(unit,target.device,target.number);naxPlayerAction(unit,naxPlayerIdForNumber(target.number),'LoadSource',{ProfileKey:source.ProfileKey||profile,ProviderKey:source.ProviderKey||item.provider||'',AutoPlay:true,SignedData:item.signedData});}}
      else throw new Error('Invalid NAX menu action');res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));
    }catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}});return;
  }
  const naxFavoriteMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/favorite$/);
  if(naxFavoriteMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxFavoriteMatch[1])}catch(_){} let body='';req.on('data',c=>{body+=c;if(body.length>100000)req.destroy()});req.on('end',()=>{try{
      const input=JSON.parse(body||'{}'),target=naxResolveTarget(id);if(!target)throw new Error('Configured NAX player not found');const unit=naxUnits.get(naxUnitKey(target.device));if(!unit)throw new Error('NAX unit is not connected');const item=naxMenuItems(unit).find(entry=>String(entry.id)===String(input.itemId));if(!item)throw new Error('NAX menu item not found');const profile=item.signedData&&item.signedData.SourceData&&item.signedData.SourceData.ProfileKey||naxProfileForPlayer(unit,target.number);naxFavoriteRequest(unit,profile,item,input.name);res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));
    }catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}});return;
  }
  const naxFavoriteDeleteMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/favorite-delete$/);
  if(naxFavoriteDeleteMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxFavoriteDeleteMatch[1])}catch(_){}let body='';req.on('data',c=>{body+=c;if(body.length>20000)req.destroy()});req.on('end',()=>{try{const input=JSON.parse(body||'{}'),target=naxResolveTarget(id);if(!target)throw new Error('Configured NAX player not found');const unit=naxUnits.get(naxUnitKey(target.device)),favorite=naxFavoriteList(unit).find(item=>String(item.id)===String(input.presetId||''));if(!favorite)throw new Error('Favorite not found');naxDeleteFavorites(unit,target.device,favorite.profile||naxProfileForPlayer(unit,target.number),[favorite.id]);res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));}catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}});return;
  }
  const naxFavoriteClearMatch=requestPath.match(/^\/api\/nax\/([^/]+)\/favorites-clear$/);
  if(naxFavoriteClearMatch&&req.method==='POST'){
    let id='';try{id=decodeURIComponent(naxFavoriteClearMatch[1])}catch(_){}try{const target=naxResolveTarget(id);if(!target)throw new Error('Configured NAX player not found');const unit=naxUnits.get(naxUnitKey(target.device));for(const[profile,data]of Object.entries(unit&&unit.favorites||{})){const ids=Object.keys(data&&data.Favorites||{});if(ids.length)naxDeleteFavorites(unit,target.device,profile,ids)}naxRemoveCachedPresets(target.device,(naxMediaCache[naxMediaCacheKey(target.device)]&&naxMediaCache[naxMediaCacheKey(target.device)].presets||[]).map(item=>item.id));res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));}catch(error){res.writeHead(400,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:false,error:error.message}))}return;
  }
  const naxArtworkMatch = requestPath.match(/^\/api\/nax\/([^/]+)\/artwork$/);
  if (naxArtworkMatch && req.method === "GET") {
    let id = ''; try { id = decodeURIComponent(naxArtworkMatch[1]); } catch (_) {}
    const target = naxResolveTarget(id); if (!target) { res.writeHead(404); return res.end('NAX player not found'); }
    const player = naxPublicPlayerState(target.device, target.number).player || {}, now = player.Player && player.Player.NowPlayingData || player.NowPlayingData || {};
    const artwork = String(now.ArtworkUrl || now.AlbumArtUrl || now.ImageUrl || now.ArtworkURL || ''); if (!artwork) { res.writeHead(404); return res.end('Artwork not available'); }
    naxFetchImage(artwork).then(result => { res.writeHead(200, { "Content-Type": result.contentType, "Cache-Control": "private, max-age=30" }); res.end(result.data); }).catch(error => { res.writeHead(502); res.end(error.message); }); return;
  }
  const naxPresetIconMatch = requestPath.match(/^\/api\/nax\/([^/]+)\/preset-icon\/([^/]+)$/);
  if (naxPresetIconMatch && req.method === "GET") {
    let id = '', presetId = ''; try { id = decodeURIComponent(naxPresetIconMatch[1]); presetId = decodeURIComponent(naxPresetIconMatch[2]); } catch (_) {}
    const target = naxResolveTarget(id), unit = target && naxUnits.get(naxUnitKey(target.device)), preset = naxFavoriteList(unit).find(item => item.id === presetId);
    if(!preset){res.writeHead(404);return res.end('Preset icon not found');}
    const serveRemembered=()=>{if(!preset.iconData)return false;try{const data=Buffer.from(preset.iconData,'base64');res.writeHead(200,{"Content-Type":preset.iconContentType||'image/png',"Cache-Control":"private, max-age=86400"});res.end(data);return true}catch(_){return false}};
    if(!preset.icon){if(!serveRemembered()){res.writeHead(404);res.end('Preset icon not found')}return;}
    naxFetchImage(preset.icon).then(result=>{naxRememberPresetImage(target.device,preset,result.data,result.contentType);res.writeHead(200,{"Content-Type":result.contentType,"Cache-Control":"private, max-age=86400"});res.end(result.data)}).catch(error=>{if(!serveRemembered()){res.writeHead(502);res.end(error.message)}});return;
  }

  if (requestPath === "/api/settings/unlock" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on("end", () => {
      try {
        const key = String(req.socket.remoteAddress || 'local');
        const failure = settingsFailures.get(key);
        if (failure && failure.blockedUntil > Date.now()) throw new Error('Too many attempts. Wait briefly and try again.');
        const input = JSON.parse(body || "{}");
        if (!verifySettingsCode(input.code)) {
          const count = (failure && !failure.blockedUntil ? failure.count : 0) + 1;
          settingsFailures.set(key, { count, blockedUntil: count >= 5 ? Date.now() + 30000 : 0 });
          throw new Error('Incorrect Settings code');
        }
        settingsFailures.delete(key);
        const token = createSettingsSession();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, token, expiresInMs: SETTINGS_SESSION_TTL }));
      } catch (error) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }

  if (requestPath === "/api/settings/heartbeat" && req.method === "POST") {
    const token = settingsTokenFromRequest(req);
    if (!extendSettingsAccess(token)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "Settings session expired" }));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (requestPath === "/api/settings/lock" && req.method === "POST") {
    settingsSessions.delete(settingsTokenFromRequest(req));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (requestPath === "/api/settings/code" && req.method === "POST") {
    const token = settingsTokenFromRequest(req);
    if (!extendSettingsAccess(token)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "Open and unlock Settings first" }));
    }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const currentCode = String(input.currentCode || "");
        const newCode = String(input.newCode || "");
        if (!verifySettingsCode(currentCode)) throw new Error('Current code is incorrect');
        if (!/^\d{4,12}$/.test(newCode)) throw new Error('New code must contain 4 to 12 digits');
        writeSettingsCode(newCode);
        for (const key of [...settingsSessions.keys()]) if (key !== token) settingsSessions.delete(key);
        settingsSessions.set(token, Date.now() + SETTINGS_SESSION_TTL);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    return;
  }

  if (requestPath === "/api/github/config" && req.method === "GET") {
    const g = readGithubConfig();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ url: g.url, hasToken: !!g.token }));
  }

  if (requestPath === "/api/github/config" && req.method === "POST") {
    if (!extendSettingsAccess(settingsTokenFromRequest(req))) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "Open and unlock Settings first" }));
    }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const current = readGithubConfig();
        const next = { url: String(input.url || current.url || "").trim(), token: input.token === undefined ? current.token : String(input.token || "") };
        parseGithubRepoUrl(next.url);
        if (!next.token) throw new Error("GitHub token is required");
        writeGithubConfig(next);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, url: next.url, hasToken: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (requestPath === "/api/github/restore-config" && req.method === "POST") {
    if (!extendSettingsAccess(settingsTokenFromRequest(req))) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "Open and unlock Settings first" }));
    }
    if (githubUpdateInProgress) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "An update is already in progress." }));
    }
    restoreConfigurationFromGithub().then(result => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, result }));
    }).catch(error => {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    });
    return;
  }

  if (requestPath === "/api/github/update-status" && req.method === "GET") {
    let status = { state: "idle" };
    try { if (fs.existsSync(UPDATE_STATUS_FILE)) status = JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, "utf8")); } catch (_) {}
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(status));
  }

  if (requestPath === "/api/github/update" && req.method === "POST") {
    if (!extendSettingsAccess(settingsTokenFromRequest(req))) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "Open and unlock Settings first" }));
    }
    if (githubUpdateInProgress) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "An update is already in progress." }));
    }
    githubUpdateInProgress = true;
    try { if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE); } catch (e) { console.error("[GITHUB] Could not back up dashboard state:", e.message); }
    try { fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: "downloading", startedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
    updateFromGithub().then(result => {
      try { fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: "staged", startedAt: new Date().toISOString(), branch: result.branch }, null, 2)); } catch (_) {}
      const launchUpdate = () => {
        try {
          const helper = path.join(result.stageDir, "apply-update.js");
          const helperArgs = [helper, result.stageDir, __dirname, String(PORT), result.packageChanged ? "1" : "0"];
          if (process.platform === "win32") {
            const vbs = path.join(result.tmpRoot, "launch-update.vbs");
            const q = v => String(v).replace(/"/g, '""');
            const command = 'shell.Run """' + q(process.execPath) + '"" ""' + q(helperArgs[0]) + '"" ""' + q(helperArgs[1]) + '"" ""' + q(helperArgs[2]) + '"" ""' + q(helperArgs[3]) + '"" ""' + q(helperArgs[4]) + '""", 0, False';
            fs.writeFileSync(vbs, ['Set shell = CreateObject("WScript.Shell")', command].join("\r\n"), "utf8");
            const wscript = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "wscript.exe") : "wscript.exe";
            const child = spawn(wscript, ["//nologo", vbs], { cwd: __dirname, detached: true, stdio: "ignore", windowsHide: true });
            child.unref();
          } else {
            const child = spawn(process.execPath, helperArgs, { cwd: __dirname, detached: true, stdio: "ignore" });
            child.unref();
          }
        } catch (e) {
          try { fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: "failed", error: e.message, finishedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
          console.error("[GITHUB] Could not start update helper:", e.message);
        }
        setTimeout(() => process.exit(0), 500);
      };
      res.once("finish", launchUpdate);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Connection": "close" });
      res.end(JSON.stringify({ ok: true, result: { owner: result.owner, repo: result.repo, branch: result.branch, updatedAt: result.updatedAt, packageChanged: result.packageChanged }, restarting: true }));
    }).catch(e => {
      githubUpdateInProgress = false;
      try { fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: "failed", error: e.message, finishedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }
  if (requestPath === "/api/state" && req.method === "GET") {
    let state = { rooms: [], sliders: [], securityDevices: [], genericDevices: [], deviceDrivers: [], presets: {}, securityMode: "Home" };
    try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) {}
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(state));
  }

  if (requestPath === "/api/state" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on("end", () => {
      try {
        const state = JSON.parse(body);
        let savedState = {};
        try { if (fs.existsSync(STATE_FILE)) savedState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) {}
        const changesConfiguration = configurationFieldsChanged(savedState, state);
        const settingsToken = settingsTokenFromRequest(req);
        if (changesConfiguration && !extendSettingsAccess(settingsToken)) {
          res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          return res.end(JSON.stringify({ ok: false, error: "Open and unlock Settings before changing configuration", state: savedState }));
        }
        const currentRevision = Number.isInteger(Number(savedState.configRevision)) ? Number(savedState.configRevision) : 0;
        const requestedRevision = Number(state && state.baseRevision);
        if (!Number.isInteger(requestedRevision) || requestedRevision !== currentRevision) {
          res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          return res.end(JSON.stringify({ ok: false, error: "Configuration changed on another screen", state: savedState }));
        }
        const validSecurityModes = new Set(["Home", "Night", "Away"]);
        const securityMode = validSecurityModes.has(String(state.securityMode || "")) ? String(state.securityMode) : (validSecurityModes.has(String(savedState.securityMode || "")) ? String(savedState.securityMode) : "Home");
        const sampleSecurityIds = new Set(["lock1", "lock2", "motion1", "motion2"]);
        const clean = {
          ...(savedState && typeof savedState === 'object' ? savedState : {}),
          rooms: Array.isArray(state.rooms) ? state.rooms.map(String).map(x => x.trim()).filter(Boolean).slice(0, 100) : [],
          sliders: Array.isArray(state.sliders) ? state.sliders.slice(0, 200) : [],
          securityDevices: Array.isArray(state.securityDevices) ? state.securityDevices.filter(x => !sampleSecurityIds.has(String(x && x.id || ""))).slice(0, 200) : [],
          genericDevices: Array.isArray(state.genericDevices) ? state.genericDevices.slice(0, 300) : [],
          deviceDrivers: Array.isArray(state.deviceDrivers) ? state.deviceDrivers.filter(driver => {
            const allowed = { lighting:['dim','switch','rgbw'], security:['lock','motion'], thermostat:['thermostat'], screen:['screen'], camera:['camera'], scene:['scene'], av:['tv','radio','nax'] };
            return driver && allowed[driver.category] && allowed[driver.category].includes(driver.baseType) && /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(String(driver.id || ''));
          }).map(driver => ({
            id: String(driver.id).slice(0,64), category: String(driver.category), name: String(driver.name || driver.id).slice(0,80), baseType: String(driver.baseType),
            description: String(driver.description || '').slice(0,240), icon: String(driver.icon || '⚙️').slice(0,24),
            ui: driver.ui && typeof driver.ui === 'object' ? {
              renderer: String(driver.ui.renderer || '').slice(0,32), icon: String(driver.ui.icon || '').slice(0,32), activeIcon: String(driver.ui.activeIcon || '').slice(0,32), inactiveIcon: String(driver.ui.inactiveIcon || '').slice(0,32),
              activeText: String(driver.ui.activeText || '').slice(0,40), inactiveText: String(driver.ui.inactiveText || '').slice(0,40), primaryAction: String(driver.ui.primaryAction || '').slice(0,40), secondaryAction: String(driver.ui.secondaryAction || '').slice(0,40),
              density: ['compact','standard','comfortable'].includes(driver.ui.density) ? driver.ui.density : 'standard', accent: /^#[0-9a-f]{6}$/i.test(String(driver.ui.accent || '')) ? String(driver.ui.accent) : '', showStatus: driver.ui.showStatus !== false,
              settingsOrder: Array.isArray(driver.ui.settingsOrder) ? driver.ui.settingsOrder.slice(0,40).map(value => String(value).slice(0,64)) : [],
              settingsPanels: Array.isArray(driver.ui.settingsPanels) ? driver.ui.settingsPanels.slice(0,12).map((panel, panelIndex) => ({
                id: String(panel && panel.id || ('panel-' + (panelIndex + 1))).replace(/[^a-z0-9._-]+/gi,'-').slice(0,64), title: String(panel && panel.title || 'Driver settings').slice(0,100), description: String(panel && panel.description || '').slice(0,300), icon: String(panel && panel.icon || '⚙️').slice(0,32), collapsible: !panel || panel.collapsible !== false, initiallyOpen: !!(panel && panel.initiallyOpen), saveLabel: String(panel && panel.saveLabel || 'Save settings').slice(0,60),
                fields: Array.isArray(panel && panel.fields) ? panel.fields.slice(0,30).map(field => ({ key:String(field && field.key || '').replace(/[^a-z0-9._-]+/gi,'-').slice(0,64), label:String(field && field.label || field && field.key || '').slice(0,100), type:['text','password','number','select','checkbox','ip','url'].includes(field && field.type) ? field.type : 'text', placeholder:String(field && field.placeholder || '').slice(0,160), description:String(field && field.description || '').slice(0,240), default:field && field.type === 'password' ? '' : (typeof (field && field.default) === 'boolean' || typeof (field && field.default) === 'number' ? field.default : String(field && field.default || '').slice(0,500)), min:Number.isFinite(Number(field && field.min)) ? Number(field.min) : undefined, max:Number.isFinite(Number(field && field.max)) ? Number(field.max) : undefined, step:Number.isFinite(Number(field && field.step)) ? Number(field.step) : undefined, width:field && field.width === 'full' ? 'full' : 'half', options:Array.isArray(field && field.options) ? field.options.slice(0,50).map(option => typeof option === 'object' ? {value:String(option.value || '').slice(0,120),label:String(option.label || option.value || '').slice(0,120)} : {value:String(option).slice(0,120),label:String(option).slice(0,120)}) : [] })) : []
              })).filter(panel => panel.id && panel.fields.length) : []
            } : {},
            settingsValues: driver.settingsValues && typeof driver.settingsValues === 'object' ? Object.fromEntries(Object.entries(driver.settingsValues).filter(([key]) => !['__proto__','constructor','prototype'].includes(key)).slice(0,300).map(([key,value]) => [String(key).slice(0,140), typeof value === 'boolean' || typeof value === 'number' ? value : String(value || '').slice(0,2000)])) : {},
            parameters: Array.isArray(driver.parameters) ? driver.parameters.slice(0,40).map(parameter => ({ key:String(parameter&&parameter.key||'').slice(0,64), label:String(parameter&&parameter.label||'').slice(0,100), kind:String(parameter&&parameter.kind||'text').slice(0,24), dpt:String(parameter&&parameter.dpt||'').slice(0,24) })) : []
          })).slice(0,200) : [],
          presets: state.presets && typeof state.presets === "object" ? state.presets : {},
          securityMode,
          configRevision: currentRevision + 1
        };
        const sampleRoomNames = new Set(["Woonkamer", "Keuken", "Eetkamer", "Slaapkamer", "Kantoor", "Badkamer", "Hal", "Overig"]);
        const usedRoomNames = new Set([...clean.sliders, ...clean.securityDevices, ...clean.genericDevices].map(x => String(x && x.room || "").trim()).filter(Boolean));
        clean.rooms = clean.rooms.filter(room => !sampleRoomNames.has(room) || usedRoomNames.has(room));
        normalizeSecurityPlacement(clean);
        fs.writeFileSync(STATE_FILE, JSON.stringify(clean, null, 2));
        // Informeer alle geopende dashboards direct, zodat laptop en iPhone
        // dezelfde configuratie tonen zonder handmatig te verversen.
        broadcast({ type: 'state-update', state: clean });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, state: clean }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  let requestPath2 = requestPath;
  if (requestPath2 === "/") requestPath2 = "/index.html";

  const file = path.join(__dirname, requestPath2);
  if (!file.startsWith(__dirname) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end("Not found");
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate" });
  res.end(fs.readFileSync(file));
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", ws => {
  sockets.add(ws);

  const knxRecentlyActive = connected || (lastKnxActivityAt > 0 && Date.now() - lastKnxActivityAt < 60000);
  ws.send(JSON.stringify({
    type: "knx-status",
    connected: knxRecentlyActive,
    message: knxRecentlyActive ? "KNX communication active" : "KNX offline"
  }));

  ws.on("message", data => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "knx-connect") {
        if (!extendSettingsAccess(msg.settingsToken)) throw new Error("Open and unlock Settings first");
        connectKNX(msg.config);
      } else if (msg.type === "knx-disconnect") {
        if (!extendSettingsAccess(msg.settingsToken)) throw new Error("Open and unlock Settings first");
        if (knx) {
          try { knx.Disconnect(); } catch (_) {}
          knx = null;
        }
        setKNXReconnectEnabled(false);
        status(false, "KNX manually disconnected");
      } else if (msg.type === "knx-update-feedback") {
        if (!extendSettingsAccess(msg.settingsToken)) throw new Error("Open and unlock Settings first");
        refreshKNXFeedbackSubscriptions(msg.config || {});} else if (msg.type === "knx-write") {
        writeKNX(msg.ga, msg.dpt, msg.value);
      } else if (msg.type === "knx-write-rgbw") {
        writeRGBW(msg.channels);
      }
    } catch (err) {
      console.error("[SERVER]", err);
      ws.send(JSON.stringify({
        type: "server-error",
        message: "Actie mislukt: " + err.message
      }));
    }
  });

  ws.on("close", () => sockets.delete(ws));
});

server.on("error", err => {
  console.error("HTTP server error:", err.message);
  process.exitCode = 1;
});

server.listen(PORT, "0.0.0.0", () => {
  startMdns();
  console.log("");
  console.log("======================================");
  console.log("       SMART HOME KNX DASHBOARD");
  console.log("======================================");
  console.log(`Dashboard : http://${MDNS_HOSTNAME}:${PORT}`);
  console.log(`Fallback  : http://<server-ip>:${PORT}`);
  console.log(`KNX router: ${DEFAULT.ip}:${DEFAULT.port}`);
  console.log(`Write GA  : ${DEFAULT.writeGa}`);
  console.log(`Feedback  : ${DEFAULT.feedbackGa}`);
  console.log("======================================");
  const savedConnection = savedKNXConnection();
  if (savedConnection) {
    console.log("[KNX] Herstellen van de opgeslagen verbinding na serverstart.");
    setTimeout(() => connectKNX(savedConnection), 500);
  }
  console.log("");
});








const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const dgram = require("dgram");
const os = require("os");
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
const STATE_BACKUP_FILE = path.join(__dirname, "smarthome_state.before-update.json");

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
  const protectedNames = new Set(["node_modules", ".git", "smarthome_state.json", "smarthome_state.before-update.json", "github_update.json", "restart-after-update.js", "apply-update.js", "START_WINDOWS.bat"]);
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

  // Syntax-check the candidate before stopping the live server.
  await runCommand(process.execPath, ["--check", stagedServer], { cwd: stageDir });

  let packageChanged = false;
  try {
    packageChanged = fs.readFileSync(stagedPackage, "utf8") !== fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
  } catch (_) {}

  return { owner, repo, branch, updatedAt: new Date().toISOString(), packageChanged, stageDir, tmpRoot };
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

function status(ok, message) {
  connected = ok;
  console.log(`[KNX] ${message}`);
  broadcast({ type: "knx-status", connected: ok, message });
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
      const cemi = packet?.cEMIMessage;
      if (!cemi?.npdu) return;

      const ga = cemi.dstAddress?.toString?.();
      const normGA = v => String(v || '').trim().replace(/\s+/g, '');
      const feedbackGAs = new Set([
        ...(Array.isArray(config.feedbackGAs) ? config.feedbackGAs : []),
        config.feedbackGa
      ].filter(Boolean).map(normGA));
      const securityFeedbackGAs = new Set((Array.isArray(config.securityFeedbackGAs) ? config.securityFeedbackGAs : []).filter(Boolean).map(normGA));
      const cameraFeedbackGAs = new Set((Array.isArray(config.cameraFeedbackGAs) ? config.cameraFeedbackGAs : []).filter(Boolean).map(normGA));
      if (!ga || (!feedbackGAs.has(normGA(ga)) && !securityFeedbackGAs.has(normGA(ga)) && !cameraFeedbackGAs.has(normGA(ga)))) return;

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
    knx.write(String(ch.ga).trim(), v, '5.001');
    console.log(`[KNX] RGBW WRITE ${String(ch.ga).trim()} 5.001 ${v}%`);
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

  if (requestPath === "/api/github/config" && req.method === "GET") {
    const g = readGithubConfig();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ url: g.url, hasToken: !!g.token }));
  }

  if (requestPath === "/api/github/config" && req.method === "POST") {
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

  if (requestPath === "/api/github/update" && req.method === "POST") {
    if (githubUpdateInProgress) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "An update is already in progress." }));
    }
    githubUpdateInProgress = true;
    try { if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE); } catch (e) { console.error('[GITHUB] Could not back up dashboard state:', e.message); }
    updateFromGithub().then(result => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Connection": "close" });
      res.end(JSON.stringify({ ok: true, result, restarting: true }));
      res.once("finish", () => {
        try {
          const helper = path.join(__dirname, "apply-update.js");
          if (process.platform === "win32") {
            // WScript is independent from the console/job that owns Node. This
            // is considerably more reliable on Windows than spawning cmd/start
            // from the process that is about to terminate.
            const vbs = path.join(result.tmpRoot, "launch-update.vbs");
            const q = v => String(v).replace(/"/g, '""');
            const script = [
              'Set shell = CreateObject("WScript.Shell")',
              `shell.Run """${q(process.execPath)}"" ""${q(helper)}"" ""${q(result.stageDir)}"" ""${q(__dirname)}"" ""${q(String(PORT))}""", 0, False`
            ].join("\r\n");
            fs.writeFileSync(vbs, script, "utf8");
            const wscript = process.env.SystemRoot
              ? path.join(process.env.SystemRoot, "System32", "wscript.exe")
              : "wscript.exe";
            const child = spawn(wscript, ["//nologo", vbs], {
              cwd: __dirname, detached: true, stdio: "ignore", windowsHide: true
            });
            child.unref();
          } else {
            const child = spawn(process.execPath, [helper, result.stageDir, __dirname, String(PORT)], {
              cwd: __dirname, detached: true, stdio: "ignore"
            });
            child.unref();
          }
        } catch (e) {
          console.error("[GITHUB] Could not start update helper:", e.message);
        }
        setTimeout(() => process.exit(0), 500);
      });
    }).catch(e => {
      githubUpdateInProgress = false;
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  if (requestPath === "/api/state" && req.method === "GET") {
    let state = { rooms: [], sliders: [], securityDevices: [], genericDevices: [], presets: {}, securityMode: "Home" };
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
        const validSecurityModes = new Set(["Home", "Night", "Away"]);
        const securityMode = validSecurityModes.has(String(state.securityMode || "")) ? String(state.securityMode) : (validSecurityModes.has(String(savedState.securityMode || "")) ? String(savedState.securityMode) : "Home");
        const clean = {
          rooms: Array.isArray(state.rooms) ? state.rooms.map(String).map(x => x.trim()).filter(Boolean).slice(0, 100) : [],
          sliders: Array.isArray(state.sliders) ? state.sliders.slice(0, 200) : [],
          securityDevices: Array.isArray(state.securityDevices) ? state.securityDevices.slice(0, 200) : [],
          genericDevices: Array.isArray(state.genericDevices) ? state.genericDevices.slice(0, 300) : [],
          presets: state.presets && typeof state.presets === "object" ? state.presets : {},
          securityMode
        };
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

  ws.send(JSON.stringify({
    type: "knx-status",
    connected,
    message: connected ? "KNX connected" : "KNX offline"
  }));

  ws.on("message", data => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "knx-connect") {
        connectKNX(msg.config);
      } else if (msg.type === "knx-disconnect") {
        if (knx) {
          try { knx.Disconnect(); } catch (_) {}
          knx = null;
        }
        status(false, "KNX manually disconnected");
      } else if (msg.type === "knx-write") {
        writeKNX(msg.ga, msg.dpt, msg.value);
      } else if (msg.type === "knx-write-rgbw") {
        writeRGBW(msg.channels);
      }
    } catch (err) {
      console.error("[SERVER]", err);
      ws.send(JSON.stringify({
        type: "knx-status",
        connected: false,
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
  console.log("");
});

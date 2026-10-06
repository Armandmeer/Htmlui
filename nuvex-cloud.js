'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const { X509Certificate, randomBytes } = require('node:crypto');

function cloudUrl(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch (_) { throw new Error('Vul een geldig HTTPS-cloudadres in.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Gebruik een HTTPS-adres zonder pad of inloggegevens.');
  return u.origin;
}
function certificate(value) {
  const pem = String(value || '').trim();
  if (!pem) return null;
  if (pem.length > 16384 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem)) throw new Error('Upload een PEM-certificaat, geen private key.');
  let cert; try { cert = new X509Certificate(pem); } catch (_) { throw new Error('Ongeldig PEM-certificaat.'); }
  if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw new Error('Het certificaat is verlopen of nog niet geldig.');
  return { pem, fingerprint: cert.fingerprint256 };
}
function safeError(error) {
  if (error.cloudStatus === 401 || error.cloudStatus === 403) return 'Cloudtoegang geweigerd. Activeer opnieuw of controleer het clouddashboard.';
  if (error.code && /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code)) return 'Cloudverbinding wacht op een geldig vooraf ingesteld servercertificaat. De installatiebeheerder moet het cloudcertificaat in het softwarepakket controleren.';
  return 'Verbinding met de cloudserver mislukt. Controleer adres, bereikbaarheid en certificaat.';
}
function systemMacAddress() {
  const candidates=[];
  for (const [name,entries] of Object.entries(os.networkInterfaces())) for (const info of entries || []) {
    if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') candidates.push({...info,name});
  }
  const virtual=/virtual|vmware|vbox|hyper-v|vpn|tunnel|bluetooth|loopback/i;
  candidates.sort((a,b)=>(virtual.test(a.name)?1:0)-(virtual.test(b.name)?1:0)||(a.family==='IPv4'?0:1)-(b.family==='IPv4'?0:1)||a.name.localeCompare(b.name));
  return String(candidates[0]?.mac||'').toUpperCase();
}
class CloudAccess {
  constructor({ directory, readUsers, version, request, remote = null, interval = 30000 }) {
    this.directory = directory; this.remote = remote;
    this.file = path.join(directory, 'nuvex_cloud_access.json');
    this.readUsers = readUsers; this.version = version; this.interval = interval;
    this.transport = request || this.request.bind(this);
    this.config = null; this.timer = null; this.generation = 0; this.pending = new Set(); this.busy = false;
    this.lastSeen = null; this.error = ''; this.started = false;
  }
  start() {
    if (this.started) return; this.started = true;
    try {
      if (!fs.existsSync(this.file)) return;
      const c = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!c.enabled || typeof c.token !== 'string' || c.token.length < 32 || (!c.automatic && !c.id) || !c.name || !c.firstEmail) throw new Error('invalid');
      c.url = cloudUrl(c.url); if (c.ca) certificate(c.ca);
      this.config = c; this.schedule(0);
    } catch (_) { this.error = 'Opgeslagen cloudinstellingen zijn ongeldig. Deactiveer en registreer opnieuw.'; }
  }
  status() {
    const c = this.config;
    return { enabled: !!c, busy: this.busy, url: c ? c.url : 'https://cloud.nuvexai.nl', name: c ? c.name : '', id: c ? c.id : '', firstEmail: c ? c.firstEmail : '', macAddress: systemMacAddress(),
      certificateFingerprint: c && c.ca ? new X509Certificate(c.ca).fingerprint256 : '', lastHeartbeat: this.lastSeen,
      online: !!c && !!this.lastSeen && Date.now() - this.lastSeen < 90000, error: this.error || (this.remote && this.remote.error) || '', remoteAccessEnabled: !!this.remote && this.remote.connected() };
  }
  trustedCa(config) {
    if (config.automatic && new URL(config.url).hostname === "192.168.40.119") {
      const file = path.join(this.directory,'nuvex-cloud-ca.pem');
      if (fs.existsSync(file)) return certificate(fs.readFileSync(file,'utf8')).pem;
    }
    return config.ca || null;
  }
  payload(name, firstEmail, preferredAdmin) {
    const users = this.readUsers();
    if (!Array.isArray(users) || !users.length || users.length > 500) throw new Error('Geen geldige Nuvex-accountlijst beschikbaar (maximaal 500 accounts).');
    const active = users.filter(u => u.role === 'admin' && u.disabled !== true);
    if (!active.length) throw new Error('Nuvex heeft geen actieve admin.');
    const normalize = value => String(value || '').trim().toLowerCase();
    if (!firstEmail) {
      firstEmail = users[0].email;
    }
    const admin = active.find(u => normalize(u.email) === normalize(preferredAdmin || firstEmail)) || active[0];
    const macAddress=systemMacAddress();if(!macAddress)throw new Error('Geen bruikbaar MAC-adres gevonden. Sluit de Nuvex-server eerst op het netwerk aan.');
    return { name, macAddress, version: this.version, firstRegisteredEmail: normalize(firstEmail), adminEmail: normalize(admin.email),
      accounts: users.map(u => ({ email: normalize(u.email), role: u.role === 'admin' ? 'admin' : 'user', disabled: u.disabled === true })) };
  }
  save(config) {
    const tmp = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file); fs.chmodSync(this.file, 0o600);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  request(config, route, body, token) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const ca = this.trustedCa(config);
      const request = https.request(new URL(route, config.url), { method: 'POST', agent: false,
        ...(ca ? { ca } : {}), rejectUnauthorized: true,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(token ? { Authorization: 'Bearer ' + token } : {}) }
      }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 131072) request.destroy(new Error('Response too large')); });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) { const error = new Error('Cloud request rejected'); error.cloudStatus = response.statusCode; return reject(error); }
          try { resolve(JSON.parse(text)); } catch (_) { reject(new Error('Invalid cloud response')); }
        });
      });
      this.pending.add(request);
      const deadline = setTimeout(() => request.destroy(new Error('Cloud timeout')), 15000);
      request.on('close', () => { clearTimeout(deadline); this.pending.delete(request); });
      request.on('error', reject); request.end(payload);
    });
  }
  async enable(input, adminEmail) {
    if (this.busy) throw new Error('Er loopt al een cloudactie.');
    if (this.config || fs.existsSync(this.file)) throw new Error('Deactiveer eerst de bestaande cloudregistratie.');
    const url = cloudUrl(input.url), name = String(input.name || '').trim(), code = String(input.pairingCode || '').trim();
    if (!name || name.length > 100 || !code || code.length > 200) throw new Error('Vul een systeemnaam en geldige koppelcode in.');
    const cert = certificate(input.certificatePem);
    const snapshot = this.payload(name, input.firstEmail, adminEmail);
    if (!snapshot.accounts.some(a => a.email === snapshot.firstRegisteredEmail)) throw new Error('Het eerste registratieadres moet bij deze eerste koppeling in de huidige accountlijst staan.');
    const config = { enabled: true, url, name, firstEmail: snapshot.firstRegisteredEmail, primaryAdmin: snapshot.adminEmail, ...(cert ? { ca: cert.pem } : {}) };
    this.busy = true;
    try {
      let response;
      try { response = await this.transport(config, '/device/register', { ...snapshot, pairingCode: code }); }
      catch (e) { throw new Error(safeError(e)); }
      if (!response || typeof response.id !== 'string' || typeof response.token !== 'string' || response.token.length < 32) throw new Error('Ongeldig antwoord van de cloudserver.');
      config.id = response.id; config.token = response.token;
      try { this.save(config); }
      catch (_) { try { await this.transport(config, '/device/disable', {}, config.token); } catch (_) {} throw new Error('Cloudsleutel kon niet veilig worden opgeslagen. Controleer maprechten.'); }
      this.config = config; this.error = ''; this.lastSeen = Date.now(); this.generation++; this.schedule(this.interval);
      return this.status();
    } finally { this.busy = false; }
  }
  async setEnabled(enabled, adminEmail, address = "https://cloud.nuvexai.nl", systemName = "") {
    if (typeof enabled !== 'boolean') throw new Error('Ongeldige checkboxwaarde.');
    if (!enabled) return this.disable();
    const url = cloudUrl(String(address).includes('://') ? address : 'https://' + address);
    const name=String(systemName||'').trim();
    if(!name||name.length>100)throw new Error('Vul eerst een duidelijke systeemnaam in (maximaal 100 tekens).');
    let warning = '';
    if (this.config) {
      if (this.config.url === url) {if(this.config.name!==name){this.config.name=name;this.save(this.config);this.schedule(0);}return this.status();}
      const result = await this.disable();
      warning = result.warning;
    }
    if (this.busy || fs.existsSync(this.file)) throw new Error('Deactiveer eerst de bestaande cloudinstellingen.');
    const snapshot = this.payload(name,null,adminEmail);
    const certFile = path.join(this.directory,'nuvex-cloud-ca.pem');
    const cert = new URL(url).hostname === '192.168.40.119' && fs.existsSync(certFile) ? certificate(fs.readFileSync(certFile,'utf8')) : null;
    const config = {enabled:true,automatic:true,url,name:snapshot.name,firstEmail:snapshot.firstRegisteredEmail,primaryAdmin:snapshot.adminEmail,token:randomBytes(48).toString('base64url'),...(cert?{ca:cert.pem}:{})};
    this.save(config);this.config=config;this.generation++;this.error='';this.lastSeen=null;this.schedule(0);
    return { ...this.status(), warning };
  }
  stop() {
    if (this.remote) this.remote.stop();
    this.generation++; clearTimeout(this.timer); this.timer = null;
    for (const req of this.pending) req.destroy(new Error('Cloud Access stopped'));
    this.pending.clear();
  }
  async disable() {
    if (this.busy) throw new Error('Er loopt al een cloudactie.');
    this.busy = true; const config = this.config; this.stop(); this.config = null; this.lastSeen = null; this.error = '';
    let remoteRevoked = !config && !fs.existsSync(this.file);
    try {
      // Erase local credentials before attempting remote revocation, even when offline.
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      if (config) {
        try { await this.transport(config, '/device/disable', {}, config.token); remoteRevoked = true; }
        catch (e) { remoteRevoked = e.cloudStatus === 401; }
      }
      return { ...this.status(), remoteRevoked, warning: remoteRevoked ? '' : 'Lokaal gedeactiveerd en alle cloudgegevens verwijderd. Intrekking op de cloudserver kon niet worden bevestigd; trek dit systeem ook in via het clouddashboard.' };
    } catch (_) { this.error = 'Cloudverbinding gestopt, maar het sleutelbestand kon niet worden verwijderd. Controleer maprechten en verwijder nuvex_cloud_access.json.'; throw new Error(this.error); }
    finally { this.busy = false; }
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (!this.config) return;
    this.timer = setTimeout(() => this.heartbeat(), delay); this.timer.unref();
  }
  async heartbeat() {
    const config = this.config, generation = this.generation;
    if (!config) return;
    let delay = this.interval;
    try {
      const snapshot = this.payload(config.name, config.firstEmail, config.primaryAdmin);
      if (config.automatic && !config.id) {
        const registration = await this.transport(config,'/device/enroll',{...snapshot,registrationKey:config.token});
        if (generation !== this.generation) return;
        if (!registration || typeof registration.id !== 'string' || !registration.id) throw new Error('Invalid registration');
        config.id=registration.id;this.save(config);
      }
      const response = await this.transport(config, '/device/heartbeat', snapshot, config.token);
      if (generation !== this.generation) return;
      if (this.remote && response.remoteAccessEnabled) this.remote.start(config,this.trustedCa(config));
      if (generation !== this.generation) return;
      this.lastSeen = Date.now(); this.error = '';
    } catch (e) {
      if (generation !== this.generation) return;
      this.error = safeError(e); delay = Math.min(this.interval * 2, 300000);
      if (e.cloudStatus === 401 || e.cloudStatus === 403) {
        this.stop(); this.config = null; this.lastSeen = null;
        try { fs.unlinkSync(this.file); } catch (_) { this.error += ' Verwijder het lokale cloudconfiguratiebestand handmatig.'; }
        return;
      }
    }
    if (generation === this.generation) this.schedule(delay);
  }
}
module.exports = { CloudAccess, cloudUrl, certificate };

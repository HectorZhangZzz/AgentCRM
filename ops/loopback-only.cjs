const fs = require('node:fs');
const net = require('node:net');

const auditFile = process.env.CRM_LAB_NETWORK_LOG;
const allowedHosts = new Set(['127.0.0.1', '::1', 'localhost']);
function audit(event) {
  if (auditFile) fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n');
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const normalized = Array.isArray(first) ? first : args;
  const options = normalized[0];
  let host = 'localhost';
  let port;
  if (typeof options === 'object' && options !== null) {
    if (options.path) return originalConnect.apply(this, args);
    host = options.host || 'localhost';
    port = options.port;
  } else {
    port = options;
    if (typeof normalized[1] === 'string') host = normalized[1];
  }
  const allowed = allowedHosts.has(host);
  audit({ type: 'connect', host, port, allowed });
  if (!allowed) {
    const error = new Error('CRM lab blocks outbound connections outside loopback');
    error.code = 'CRM_LAB_EGRESS_BLOCKED';
    throw error;
  }
  return originalConnect.apply(this, args);
};

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[0] && typeof args[0] === 'object' && 'port' in args[0]) {
    args[0] = { ...args[0], host: '127.0.0.1' };
  } else if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
    if (typeof args[1] === 'string') args[1] = '127.0.0.1';
    else args.splice(1, 0, '127.0.0.1');
  }
  return originalListen.apply(this, args);
};

if (globalThis.fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const allowed = allowedHosts.has(target.hostname);
    audit({ type: 'fetch', host: target.hostname, port: target.port || null, allowed });
    if (!allowed) throw new Error('CRM lab blocks outbound fetch outside loopback');
    return originalFetch.call(this, input, init);
  };
}


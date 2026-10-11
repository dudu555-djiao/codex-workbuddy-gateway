import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export async function privateDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new BridgeError('bridge/insecure-path', `Bridge directory must be owned by this user and mode 0700: ${path}`);
  return path;
}
export async function privateFile(path) {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new BridgeError('bridge/insecure-path', `Bridge file must be owned by this user and mode 0600: ${path}`);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true; // Unknown owner fails closed.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function authorized(value, token) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const received = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
function safeError(error) {
  // Do not return exception stacks, auth headers, runtime env, or config secrets.
  return { code: typeof error?.code === 'string' ? error.code : 'bridge/internal', message: error instanceof Error ? error.message : 'Bridge operation failed', ...(error?.admissionRejected === true ? { admissionRejected: true } : {}) };
}
async function bodyOf(req, maxBytes) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new BridgeError('bridge/body-too-large', 'RPC body exceeds 1 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('bridge/bad-request', 'RPC body must be JSON'); }
}
/** Private AF_UNIX endpoint; no TCP listener or remote auth workaround. */
export async function startTransport(options) {
  if (typeof process.getuid !== 'function') throw new BridgeError('bridge/unsupported-platform', 'This bridge requires Unix filesystem ownership checks');
  const root = await privateDirectory(options.root ?? join(homedir(), '.dsh', 'codex-bridge'));
  const hosts = await privateDirectory(join(root, 'hosts'));
  if (!/^[a-z0-9-]{8,64}$/.test(options.hostId)) throw new BridgeError('bridge/invalid-host', 'Invalid logical Host identity');
  const registryPath = join(hosts, `${options.hostId}.json`);
  const socketPath = join(root, `${options.hostId.slice(0, 24)}-${process.pid}-${randomBytes(3).toString('hex')}.sock`);
  // Darwin's sockaddr_un.sun_path is only 104 bytes including the NUL.
  if (Buffer.byteLength(socketPath) > 100) throw new BridgeError('bridge/socket-path-too-long', 'Bridge home is too long for a Unix socket');
  const token = randomBytes(32).toString('hex');
  const registration = { ...options.identity, hostId: options.hostId, socketPath, token, pid: process.pid, protocolVersion: 1, registeredAt: new Date().toISOString() };
  let ownsRegistration = false;
  async function claim() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await fs.open(registryPath, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(registration)); await file.sync(); } finally { await file.close(); }
        ownsRegistration = true; return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await privateFile(registryPath);
        const before = await fs.lstat(registryPath);
        const previous = JSON.parse(await fs.readFile(registryPath, 'utf8'));
        const after = await fs.lstat(registryPath);
        if (before.ino !== after.ino || before.dev !== after.dev) continue;
        if (alive(previous.pid)) throw new BridgeError('bridge/host-already-active', 'Another live Host already owns this profile bridge');
        if (before.ino === after.ino) await fs.unlink(registryPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
    }
    throw new BridgeError('bridge/registration-conflict', 'Unable to claim this profile bridge');
  }
  let active = 0;
  const controllers = new Set();
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    function respond(status, value) {
      if (res.destroyed) return;
      let output = JSON.stringify(value);
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) {
        status = 413;
        output = JSON.stringify({ ok: false, error: { code: 'bridge/response-too-large', message: 'Use a smaller event page limit' } });
      }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' }); res.end(output);
    }
    if (req.method !== 'POST' || req.url !== '/rpc') return respond(404, { ok: false, error: { code: 'bridge/not-found', message: 'Use POST /rpc' } });
    if (!authorized(req.headers.authorization, token)) return respond(401, { ok: false, error: { code: 'bridge/unauthorized', message: 'Private bridge authentication required' } });
    if (active >= (options.maxPending ?? 32)) return respond(429, { ok: false, error: { code: 'bridge/busy', message: 'Too many pending bridge requests', admissionRejected: true } });
    active++;
    let operationStarted = false;
    const abort = new AbortController(); controllers.add(abort);
    const timer = setTimeout(() => abort.abort(new BridgeError('bridge/timeout', 'Bridge request timed out')), options.timeoutMs ?? 30000);
    timer.unref();
    req.on('aborted', () => abort.abort(new BridgeError('bridge/disconnected', 'RPC client disconnected')));
    try {
      const body = await bodyOf(req, 1024 * 1024);
      if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string' || body.params !== undefined && (body.params === null || typeof body.params !== 'object' || Array.isArray(body.params))) throw new BridgeError('bridge/bad-request', 'Expected {method,params}');
      abort.signal.throwIfAborted();
      operationStarted = true;
      const operation = Promise.resolve().then(() => options.invoke(body.method, body.params ?? {}, abort.signal));
      // Keep the pending slot until native work settles, even after the caller timeout.
      let settled = false;
      operation.finally(() => { settled = true; active--; controllers.delete(abort); clearTimeout(timer); }).catch(() => {});
      const timeout = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
      if (abort.signal.aborted) throw abort.signal.reason;
      try { respond(200, { ok: true, value: await Promise.race([operation, timeout]) }); }
      finally { if (!settled) operation.catch(() => {}); }
    } catch (error) { respond(400, { ok: false, error: { ...safeError(error), ...(!operationStarted ? { admissionRejected: true } : {}) } }); }
    finally { if (!operationStarted) { active--; clearTimeout(timer); controllers.delete(abort); } }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 64;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  function removeOwnedSync() {
    if (!ownsRegistration) return;
    try {
      const stat = lstatSync(registryPath);
      const current = stat.isFile() && !stat.isSymbolicLink() ? JSON.parse(readFileSync(registryPath, 'utf8')) : undefined;
      if (current?.pid === process.pid && current.token === token) unlinkSync(registryPath);
    } catch (error) { if (error.code !== 'ENOENT') { /* shutdown must not crash the Host */ } }
    try { unlinkSync(socketPath); } catch { /* already removed */ }
  }
  const onExit = () => removeOwnedSync();
  try {
    await claim();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
    await fs.chmod(socketPath, 0o600);
    const socketStat = await fs.lstat(socketPath);
    if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o077)) throw new BridgeError('bridge/insecure-socket', 'Unix socket ownership check failed');
    process.once('exit', onExit);
  } catch (error) { server.close(); removeOwnedSync(); throw error; }
  return {
    registration, registryPath,
    async close() {
      process.off('exit', onExit);
      for (const controller of controllers) controller.abort(new BridgeError('bridge/stopped', 'Host bridge stopped'));
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve()));
      removeOwnedSync(); ownsRegistration = false;
    },
  };
}

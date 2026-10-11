import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startTransport } from '../transport.mjs';
const invoke = (socketPath, token, body, method = 'POST') => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: '/rpc', method, headers: { Authorization: `Bearer ${token}` } }, res => {
    let raw = ''; res.on('data', x => raw += x); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) }));
  }); req.on('error', reject); req.end(typeof body === 'string' ? body : JSON.stringify(body));
});
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-b-'));
  const bridge = await startTransport({ root, hostId: 'dsh-test-one', identity: { profile: 'desktop', runtimeSource: 'deepseek-desktop' }, invoke: async (method, params) => ({ method, params }), ...options });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, bridge, ...bridge.registration };
}
test('Unix transport authenticates and keeps registry/socket private', async t => {
  const { root, bridge, socketPath, token } = await fixture(t);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(bridge.registryPath)).mode & 0o777, 0o600);
  assert.equal((await invoke(socketPath, 'wrong', { method: 'health' })).status, 401);
  const result = await invoke(socketPath, token, { method: 'health', params: {} });
  assert.equal(result.ok, true); assert.equal(result.value.method, 'health');
});
test('malformed authenticated requests release bounded slots', async t => {
  const { socketPath, token } = await fixture(t, { maxPending: 1 });
  for (let i = 0; i < 5; i++) { const result = await invoke(socketPath, token, '{bad'); assert.equal(result.status, 400); assert.equal(result.error.admissionRejected, true); }
  assert.equal((await invoke(socketPath, token, { method: 'health' })).ok, true);
});
test('same profile cannot override a live Host and shutdown removes its registration', async t => {
  const { root, bridge, socketPath } = await fixture(t);
  await assert.rejects(startTransport({ root, hostId: 'dsh-test-one', identity: {}, invoke: async () => ({}) }), error => error.code === 'bridge/host-already-active');
  await bridge.close();
  await assert.rejects(fs.lstat(bridge.registryPath), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' });
});
test('insecure registry directories fail closed without chmod of existing paths', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-b-')); await fs.chmod(root, 0o755);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(startTransport({ root, hostId: 'dsh-test-one', identity: {}, invoke: async () => ({}) }), error => error.code === 'bridge/insecure-path');
});
test('independent profile identities register concurrently', async t => {
  const { root } = await fixture(t);
  const second = await startTransport({ root, hostId: 'dsh-test-two', identity: { profile: 'web' }, invoke: async () => ({}) });
  t.after(() => second.close());
  assert.equal((await fs.readdir(join(root, 'hosts'))).filter(x => x.endsWith('.json')).length, 2);
});
test('stale registration can be reclaimed by the same stable Host identity', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-b-')); await fs.mkdir(join(root, 'hosts'), { mode: 0o700 });
  const registry = join(root, 'hosts', 'dsh-stale-one.json');
  await fs.writeFile(registry, JSON.stringify({ pid: 2147483647, token: 'stale-token', hostId: 'dsh-stale-one' }), { mode: 0o600 });
  const bridge = await startTransport({ root, hostId: 'dsh-stale-one', identity: {}, invoke: async () => ({}) });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(JSON.parse(await fs.readFile(registry, 'utf8')).pid, process.pid);
});
test('registration replaced during a stale-owner read is never unlinked as stale', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-b-')); await fs.mkdir(join(root, 'hosts'), { mode: 0o700 });
  const registry = join(root, 'hosts', 'dsh-race-one.json');
  await fs.writeFile(registry, JSON.stringify({ pid: 2147483647, token: 'old' }), { mode: 0o600 });
  const realRead = fs.readFile; let replaced = false;
  fs.readFile = async function(path, ...args) {
    const value = await realRead.call(fs, path, ...args);
    if (path === registry && !replaced) {
      replaced = true;
      const next = `${registry}.next`;
      await fs.writeFile(next, JSON.stringify({ pid: process.pid, token: 'active' }), { mode: 0o600 });
      await fs.rename(next, registry);
    }
    return value;
  };
  try {
    await assert.rejects(startTransport({ root, hostId: 'dsh-race-one', identity: {}, invoke: async () => ({}) }), e => e.code === 'bridge/host-already-active');
    assert.equal(JSON.parse(await realRead.call(fs, registry, 'utf8')).token, 'active');
  } finally { fs.readFile = realRead; await fs.rm(root, { recursive: true, force: true }); }
});
test('native operations remain bounded after an HTTP timeout until they settle', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { socketPath, token } = await fixture(t, { maxPending: 1, timeoutMs: 10, invoke: async () => pending });
  const first = await invoke(socketPath, token, { method: 'health' }); assert.equal(first.error.code, 'bridge/timeout');
  const rejected = await invoke(socketPath, token, { method: 'health' }); assert.equal(rejected.status, 429); assert.equal(rejected.error.admissionRejected, true);
  release('done');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await invoke(socketPath, token, { method: 'health' })).ok, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, verifyCapabilities, logicalIdentity } from '../adapter.mjs';
const sig = () => new AbortController().signal;
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-ad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = { name: 'desktop', dir: root };
  const events = [];
  const append = (type, data) => { events.push({ type, data, seq: events.length, time: Date.now() }); };
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  agent.session = { id: 'session-one', snapshotEvents: () => [...events] };
  let prompts = 0; let cancellations = 0; let removals = 0;
  const controller = {
    async inspect() { return { meta: { id: 'session-one', cwd: root }, events: [...events] }; },
    async list() { return { items: [{ sessionId: 'session-one', cwd: root, running: agent.status === 'running' }] }; },
    async create() { return { sessionId: 'session-one' }; },
    async rename({ title }) { append('session/title', { title }); return { title, seq: events.length - 1 }; },
    async prompt({ requestId, content, mode }) {
      assert.equal(mode, 'queue'); prompts++;
      const message = { id: 'message-one', source: { kind: 'user', rpcId: requestId }, content };
      append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
      append('turn/start', { turn: 1 });
      append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
      append('step/start', { turn: 1, step: 1 }); append('user/message', message);
      append('assistant/message', { message: { content: [{ type: 'text', text: 'actual result' }] } });
      append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      return { accepted: true };
    },
    cancel() { cancellations++; return { accepted: true }; },
    async updateQueue({ itemId, action }) { assert.equal(itemId, 'message-one'); assert.equal(action.kind, 'remove'); removals++; append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }); agent.inbox.nextTurn = []; return { accepted: true }; },
    ...overrides,
  };
  const ctx = { sessionController: controller, agents: { get: () => agent }, get: key => key === 'profileContext' ? profile : key === 'pluginPackages' ? { packageOf: () => ({ version: '0.2.0-rc.2' }) } : undefined };
  const identity = await logicalIdentity(ctx);
  const adapter = await createAdapter(ctx, { root, ...identity });
  return { root, ctx, profile, identity, adapter, events, append, agent, controller, counts: () => ({ prompts, cancellations, removals }) };
}
test('adapter dispatches once and reconstructs results after plugin restart', async t => {
  const f = await fixture(t);
  const input = { sessionId: 'session-one', requestId: 'request-one', text: 'create file' };
  const one = await f.adapter.invoke('prompt', input, sig()); assert.equal(one.accepted, true);
  const restarted = await createAdapter(f.ctx, { root: f.root, ...f.identity });
  const two = await restarted.invoke('prompt', input, sig()); assert.equal(two.duplicate, true); assert.equal(f.counts().prompts, 1);
  const page = await restarted.invoke('events', { sessionId: input.sessionId, requestId: input.requestId, afterSeq: -1, limit: 100 }, sig());
  assert.equal(page.events.at(-1).type, 'completed'); assert.equal(page.events.at(-1).text, 'actual result');
  await assert.rejects(restarted.invoke('prompt', { ...input, text: 'different' }, sig()), e => e.code === 'bridge/request-conflict' && e.admissionRejected === true);
});
test('busy rejection is explicitly before native admission and writes no reservation', async t => {
  const f = await fixture(t); f.agent.status = 'running';
  await assert.rejects(f.adapter.invoke('prompt', { sessionId: 'session-one', requestId: 'r', text: 'x' }, sig()), e => e.code === 'bridge/session-busy' && e.admissionRejected === true);
  assert.equal(f.counts().prompts, 0);
  assert.equal((await fs.readdir(join(f.root, 'requests', f.identity.hostId))).length, 0);
});
test('native admission failure retains a reservation and cannot be resent', async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { async prompt() { nativeCalls++; throw new Error('native dispatch interrupted'); } });
  const input = { sessionId: 'session-one', requestId: 'r', text: 'x' };
  for (let i = 0; i < 2; i++) await assert.rejects(f.adapter.invoke('prompt', input, sig()), e => e.code === 'bridge/admission-unknown' && !e.admissionRejected);
  assert.equal(nativeCalls, 1);
});
test('post-admission inspection failure is never labelled rejected', async t => {
  const f = await fixture(t); const original = f.controller.inspect; let reads = 0;
  f.controller.inspect = async () => { if (++reads > 1) throw Object.assign(new Error('lost inspect'), { code: 'session/not-found' }); return original(); };
  await assert.rejects(f.adapter.invoke('prompt', { sessionId: 'session-one', requestId: 'r', text: 'x' }, sig()), e => e.code === 'bridge/admission-unknown' && !e.admissionRejected);
  assert.equal(f.counts().prompts, 1);
});
test('queued cancellation removes only the exact request and waits for durable evidence', async t => {
  const f = await fixture(t);
  const message = { id: 'message-one', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: 'x' }] };
  f.agent.inbox.nextTurn.push(message); f.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
  const result = await f.adapter.invoke('cancel', { sessionId: 'session-one', requestId: 'r' }, sig());
  assert.deepEqual(result, { requested: true, stopped: false, queueRemoval: true });
  assert.deepEqual(f.counts(), { prompts: 0, cancellations: 0, removals: 1 });
  const page = await f.adapter.invoke('events', { sessionId: 'session-one', requestId: 'r' }, sig());
  assert.equal(page.events.at(-1).type, 'cancelled');
});
test('unrelated cancellation and arbitrary methods fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.invoke('cancel', { sessionId: 'session-one', requestId: 'other' }, sig()), e => e.code === 'bridge/request-not-active');
  await assert.rejects(f.adapter.invoke('eval', { code: 'x' }, sig()), e => e.code === 'bridge/method-not-allowed');
  assert.equal(f.counts().cancellations, 0);
});
test('logical host identity survives plugin instances, remains distinct per profile and rejects incompatible runtime', async t => {
  const f = await fixture(t); assert.equal((await logicalIdentity(f.ctx)).hostId, f.identity.hostId);
  f.profile.name = 'web'; assert.notEqual((await logicalIdentity(f.ctx)).hostId, f.identity.hostId);
  f.profile.name = 'cli'; assert.throws(() => verifyCapabilities(f.ctx), e => e.code === 'bridge/unsupported-host');
  f.profile.name = 'desktop'; const originalGet = f.ctx.get;
  f.ctx.get = key => key === 'pluginPackages' ? { packageOf: () => ({ version: '0.1.6-alpha.2' }) } : originalGet(key);
  assert.throws(() => verifyCapabilities(f.ctx), e => e.code === 'bridge/unsupported-version');
});
test('native rename sets visible session title without spawning an independent Host', async t => {
  const f = await fixture(t);
  const result = await f.adapter.invoke('create', { workspace: f.root, title: 'Codex bridge test' }, sig());
  assert.equal(result.sessionId, 'session-one'); assert.equal(result.titleApplied, true); assert.equal(result.title, 'Codex bridge test'); assert.equal(result.workspace, f.root);
});

test('active cancellation rechecks native ownership after an awaited cold snapshot', async t => {
  const f = await fixture(t); f.agent.status = 'running';
  const message = id => ({ id: `message-${id}`, source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text: id }] });
  const open = (id, turn) => {
    f.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message(id)] });
    f.append('turn/start', { turn });
    f.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    f.append('step/start', { turn, step: 1 });
  };
  open('ours', 1);
  const original = f.controller.inspect;
  f.controller.inspect = async () => {
    const stale = await original();
    f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    open('foreign', 2);
    return stale;
  };
  await assert.rejects(f.adapter.invoke('cancel', { sessionId: 'session-one', requestId: 'ours' }, sig()), e => e.code === 'bridge/request-not-active');
  assert.equal(f.counts().cancellations, 0);
});
test('active cancellation with synchronous live proof requests stop but never proves it by idle', async t => {
  const f = await fixture(t); f.agent.status = 'running';
  const message = { id: 'message-one', source: { kind: 'user', rpcId: 'ours' }, content: [{ type: 'text', text: 'x' }] };
  f.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
  f.append('turn/start', { turn: 1 });
  f.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  f.append('step/start', { turn: 1, step: 1 });
  const result = await f.adapter.invoke('cancel', { sessionId: 'session-one', requestId: 'ours' }, sig());
  assert.deepEqual(result, { requested: true, stopped: false });
  assert.equal(f.counts().cancellations, 1);
});

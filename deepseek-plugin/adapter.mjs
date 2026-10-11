import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { BridgeError, privateDirectory, privateFile } from './transport.mjs';
import { replayEvents, eventPage, requestOf } from './events.mjs';

export const SUPPORTED_VERSION = '0.2.0-rc.2';
export const METHODS = Object.freeze(['health', 'sessions', 'create', 'session', 'prompt', 'events', 'cancel']);
const hash = value => createHash('sha256').update(value).digest('hex');
function string(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new BridgeError('bridge/bad-request', `${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
function keys(params, allowed) {
  for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new BridgeError('bridge/bad-request', `Unsupported parameter: ${key}`);
}
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BridgeError('bridge/bad-request', `${name} is outside its allowed range`);
  return value;
}
export function verifyCapabilities(ctx) {
  const profile = ctx.get('profileContext');
  if (!profile || !['desktop', 'web'].includes(profile.name)) throw new BridgeError('bridge/unsupported-host', 'Load this plugin into an existing desktop or web profile Host');
  const metadata = ctx.get('pluginPackages')?.packageOf('@deepseek-ai/dsh-api-session-controller', ctx.baseUrl ?? import.meta.url);
  if (metadata?.version !== SUPPORTED_VERSION) throw new BridgeError('bridge/unsupported-version', `Bridge requires session-controller ${SUPPORTED_VERSION}; found ${metadata?.version ?? 'unknown'}`);
  for (const method of ['list', 'inspect', 'create', 'prompt', 'cancel', 'updateQueue']) if (typeof ctx.sessionController?.[method] !== 'function') throw new BridgeError('bridge/missing-capability', `Harness sessionController.${method} is unavailable`);
  if (typeof ctx.agents?.get !== 'function') throw new BridgeError('bridge/missing-capability', 'Harness Agent registry is unavailable');
  return profile;
}
export async function createAdapter(ctx, { root, hostId, identity }) {
  const ledgerRoot = await privateDirectory(join(await privateDirectory(root), 'requests'));
  const ledgerDir = await privateDirectory(join(ledgerRoot, hostId));
  const locks = new Map();
  const controller = ctx.sessionController;
  const profile = ctx.get('profileContext');
  async function inspect(sessionId, signal) {
    const result = await controller.inspect(sessionId, signal);
    if (!result || result.meta?.id !== sessionId || !Array.isArray(result.events)) throw new BridgeError('bridge/session-identity-mismatch', 'Harness returned an inconsistent Session identity');
    return result;
  }
  function summary(meta, replay) {
    const agent = ctx.agents.get(meta.id);
    const running = agent?.status === 'running';
    const pending = Boolean(agent?.inbox?.nextTurn?.length || agent?.inbox?.nextStep?.length);
    return {
      sessionId: meta.id, workspace: meta.cwd, cwd: meta.cwd,
      preset: meta.agentPreset, busy: running || pending, running,
      ...(replay?.activeRequests?.length === 1 ? { activeRequestId: replay.activeRequests[0] } : {}),
      identity: { hostId, profile: identity.profile, runtimeSource: identity.runtimeSource, sessionId: meta.id },
    };
  }
  async function session(sessionId, signal) {
    const state = await inspect(sessionId, signal);
    const title = state.events.findLast(event => event.type === 'session/title')?.data?.title;
    return { ...summary(state.meta, replayEvents(sessionId, state.events)), ...(typeof title === 'string' ? { title } : {}) };
  }
  async function exclusive(sessionId, fn) {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(fn);
    locks.set(sessionId, work);
    try { return await work; } finally { if (locks.get(sessionId) === work) locks.delete(sessionId); }
  }
  const ledgerPath = (sessionId, requestId) => join(ledgerDir, `${hash(`${sessionId}\0${requestId}`)}.json`);
  async function readLedger(path) {
    try { await privateFile(path); return JSON.parse(await fs.readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function writeLedger(path, record) {
    const temp = `${path}.${process.pid}.tmp`;
    const file = await fs.open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    try { await fs.rename(temp, path); } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function prompt(params, signal) {
    let nativeSubmitted = false;
    try {
    keys(params, ['sessionId', 'requestId', 'text']);
    const sessionId = string(params.sessionId, 'sessionId');
    const requestId = string(params.requestId, 'requestId');
    const text = string(params.text, 'text', 200000);
    return await exclusive(sessionId, async () => {
      signal.throwIfAborted();
      const path = ledgerPath(sessionId, requestId);
      const existing = await readLedger(path);
      if (existing && (existing.requestId !== requestId || existing.sessionId !== sessionId || existing.textHash !== hash(text))) throw new BridgeError('bridge/request-conflict', 'requestId was already used with different prompt content');
      const state = await inspect(sessionId, signal);
      const replay = replayEvents(sessionId, state.events);
      const nativeRequest = replay.requests.get(requestId);
      if (!existing && nativeRequest?.promptText !== undefined && nativeRequest.promptText !== text) throw new BridgeError('bridge/request-conflict', 'requestId already belongs to different native prompt content');
      if (nativeRequest || existing?.state === 'accepted') {
        nativeSubmitted = true; // Proven already admitted; later I/O errors cannot mean rejection.
        if (!existing || existing.state !== 'accepted') await writeLedger(path, { sessionId, requestId, textHash: hash(text), state: 'accepted', acceptedAt: new Date().toISOString() });
        return { requestId, accepted: true, ...(nativeRequest?.turnId ? { turnId: nativeRequest.turnId } : {}), duplicate: true };
      }
      if (existing) throw new BridgeError('bridge/admission-unknown', 'This request was reserved before a disconnect. No duplicate dispatch is allowed; inspect the App and synchronize persisted events');
      const current = summary(state.meta, replay);
      if (current.busy) throw new BridgeError('bridge/session-busy', 'Session already has running or queued work');
      const record = { sessionId, requestId, textHash: hash(text), state: 'reserved', reservedAt: new Date().toISOString() };
      const reservation = await fs.open(path, 'wx', 0o600);
      try { await reservation.writeFile(JSON.stringify(record)); await reservation.sync(); } finally { await reservation.close(); }
      // Native prompt uses source.rpcId=requestId and checks inbox + durable messages.
      // If admission errors or transport dies after this point, retain the reservation.
      nativeSubmitted = true;
      const result = await controller.prompt({ sessionId, requestId, content: [{ type: 'text', text }], mode: 'queue', clientTimeZone: 'Asia/Shanghai' }, signal);
      if (result?.accepted !== true) throw new BridgeError('bridge/admission-unknown', 'Harness did not acknowledge the prompt; do not resend');
      await writeLedger(path, { ...record, state: 'accepted', acceptedAt: new Date().toISOString() });
      const acceptedState = await inspect(sessionId, signal);
      const accepted = replayEvents(sessionId, acceptedState.events).requests.get(requestId);
      return { requestId, accepted: true, ...(accepted?.turnId ? { turnId: accepted.turnId } : {}) };
    });
    } catch (error) {
      if (nativeSubmitted || error?.code === 'bridge/admission-unknown') throw new BridgeError('bridge/admission-unknown', 'Prompt admission may have succeeded. Synchronize persisted events; no duplicate dispatch is allowed');
      const rejection = new BridgeError(typeof error?.code === 'string' ? error.code : 'bridge/pre-admission-failure', error instanceof Error ? error.message : 'Prompt rejected before native admission');
      rejection.admissionRejected = true;
      throw rejection;
    }
  }
  return {
    async invoke(method, params, signal) {
      if (!METHODS.includes(method)) throw new BridgeError('bridge/method-not-allowed', 'RPC method is not allowed');
      signal.throwIfAborted();
      switch (method) {
        case 'health':
          keys(params, []);
          return { ok: true, hostId, pid: process.pid, protocolVersion: 1, version: SUPPORTED_VERSION, profile: identity.profile, runtimeSource: identity.runtimeSource, methods: METHODS, approvalHandling: 'Harness UI only; bridge never auto-approves', nativePersistence: true };
        case 'sessions': {
          keys(params, []);
          const result = await controller.list({}, signal);
          if (!Array.isArray(result.items)) throw new BridgeError('bridge/invalid-native-result', 'Harness returned an invalid Session list');
          return { sessions: result.items.map(item => ({ sessionId: item.sessionId, workspace: item.cwd, cwd: item.cwd, busy: item.running, running: item.running, preset: item.agentPreset, title: item.projections?.values?.title ?? undefined, identity: { hostId, profile: identity.profile, runtimeSource: identity.runtimeSource, sessionId: item.sessionId } })) };
        }
        case 'session':
          keys(params, ['sessionId']); return session(string(params.sessionId, 'sessionId'), signal);
        case 'create': {
          keys(params, ['workspace', 'cwd', 'agentPreset', 'sessionId', 'title']);
          if (params.workspace && params.cwd && params.workspace !== params.cwd) throw new BridgeError('bridge/bad-request', 'workspace and cwd must name the same directory');
          const cwd = params.workspace ?? params.cwd;
          if (cwd !== undefined) {
            string(cwd, 'workspace', 8192);
            if (!isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw new BridgeError('bridge/bad-request', 'workspace must be an existing absolute directory');
          }
          if (params.title !== undefined) string(params.title, 'title', 200);
          const result = await controller.create({ ...(cwd === undefined ? {} : { cwd }), ...(params.agentPreset === undefined ? {} : { agentPreset: string(params.agentPreset, 'agentPreset') }), ...(params.sessionId === undefined ? {} : { sessionId: string(params.sessionId, 'sessionId') }) });
          let titleApplied;
          if (params.title !== undefined) {
            titleApplied = false;
            if (typeof controller.rename === 'function') {
              try { await controller.rename({ sessionId: result.sessionId, title: params.title }); titleApplied = true; } catch { /* Created identity still returns when optional title mutation fails. */ }
            }
          }
          return { ...await session(result.sessionId, signal), ...(titleApplied === undefined ? {} : { titleApplied }) };
        }
        case 'prompt': return prompt(params, signal);
        case 'events': {
          keys(params, ['sessionId', 'requestId', 'afterSeq', 'limit']);
          const sessionId = string(params.sessionId, 'sessionId');
          const requestId = params.requestId === undefined ? undefined : string(params.requestId, 'requestId');
          const afterSeq = integer(params.afterSeq ?? -1, 'afterSeq', -1, Number.MAX_SAFE_INTEGER);
          const limit = integer(params.limit ?? 100, 'limit', 1, 256);
          const state = await inspect(sessionId, signal);
          return eventPage(replayEvents(sessionId, state.events), { requestId, afterSeq, limit });
        }
        case 'cancel': {
          keys(params, ['sessionId', 'requestId']);
          const sessionId = string(params.sessionId, 'sessionId');
          const requestId = string(params.requestId, 'requestId');
          return exclusive(sessionId, async () => {
            const state = await inspect(sessionId, signal);
            const replay = replayEvents(sessionId, state.events);
            if (['completed', 'failed', 'cancelled'].includes(replay.requests.get(requestId)?.state)) return { requested: false, stopped: false, alreadyEnded: true };
            const agent = ctx.agents.get(sessionId);
            const pending = [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])].find(message => requestOf(message) === requestId);
            if (pending) {
              const result = await controller.updateQueue({ sessionId, itemId: pending.id, action: { kind: 'remove' } });
              return { requested: result?.accepted === true, stopped: false, queueRemoval: true };
            }
            if (!replay.activeRequests.includes(requestId)) throw new BridgeError('bridge/request-not-active', 'Requested task does not own the active turn; no unrelated turn was cancelled');
            // inspect() may have yielded while the native driver advanced to a different
            // queued turn. Recheck the live Session synchronously, then invoke without
            // another await so a foreign turn cannot be cancelled from a stale snapshot.
            const liveAgent = ctx.agents.get(sessionId);
            if (liveAgent?.session?.id !== sessionId || typeof liveAgent.session.snapshotEvents !== 'function') throw new BridgeError('bridge/live-session-unavailable', 'Cannot verify the live turn identity; no cancellation was dispatched');
            const live = replayEvents(sessionId, liveAgent.session.snapshotEvents());
            if (!live.activeRequests.includes(requestId) || live.requests.get(requestId)?.turnId !== replay.requests.get(requestId)?.turnId) throw new BridgeError('bridge/request-not-active', 'The requested turn ended or changed before cancellation; no unrelated turn was cancelled');
            const result = controller.cancel({ sessionId });
            return { requested: result?.accepted === true, stopped: false };
          });
        }
      }
    },
  };
}
export async function logicalIdentity(ctx) {
  const profile = verifyCapabilities(ctx);
  const profileDir = await fs.realpath(profile.dir);
  const runtimeSource = profile.name === 'desktop' ? 'deepseek-desktop' : 'deepseek-web';
  return { hostId: `dsh-${hash(`${profileDir}\0${runtimeSource}`).slice(0, 20)}`, identity: { version: SUPPORTED_VERSION, profile: profile.name, profileDir, runtimeSource } };
}

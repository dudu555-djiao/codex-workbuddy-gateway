/** Replay ONLY original, committed Harness events; never infer completion from idle. */
export function requestOf(message) {
  return message?.source?.kind === 'user' && typeof message.source.rpcId === 'string'
    ? message.source.rpcId : undefined;
}
function textOf(data) {
  const content = data?.content ?? data?.message?.content;
  return Array.isArray(content) ? content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : undefined;
}
function turnId(sessionId, turn) { return `${sessionId}:turn:${turn}`; }
function endType(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed';
    case 'aborted': return 'cancelled';
    default: return 'failed';
  }
}
/**
 * Claims are durable inbox removals following turn/start. Retrospective ownership
 * lets turn/start retain its original seq even though request identity arrives later.
 * Requests merely queued during a different turn never inherit that turn's ending.
 */
export function replayEvents(sessionId, events) {
  const queues = { 'next-turn': [], 'next-step': [] };
  const turnRequests = new Map();
  const requests = new Map();
  const annotated = [];
  const assistantFinals = new Map();
  const stepped = new Set();
  const lastAdmission = new Map();
  let currentTurn;
  for (const raw of events) {
    if (!Number.isSafeInteger(raw?.seq) || typeof raw?.type !== 'string') throw new Error('Invalid committed Harness event');
    const data = raw.data ?? {};
    if (raw.type === 'turn/start') {
      currentTurn = data.turn;
      if (!turnRequests.has(currentTurn)) turnRequests.set(currentTurn, new Set());
    }
    if (raw.type === 'step/start') stepped.add(data.turn ?? currentTurn);
    let explicit;
    let kind = 'progress';
    if (raw.type === 'agent/inbox/spliced') {
      const queue = queues[data.target];
      if (!queue || !Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.removedCount ?? 0) || !Array.isArray(data.inserted)) throw new Error('Invalid durable inbox splice');
      const removed = queue.splice(data.start, data.removedCount ?? 0, ...data.inserted);
      const insertedIds = data.inserted.map(requestOf).filter(Boolean);
      for (const id of insertedIds) {
        lastAdmission.set(id, raw.seq);
        const inserted = data.inserted.find(message => requestOf(message) === id);
        requests.set(id, { ...requests.get(id), requestId: id, accepted: true, promptText: textOf(inserted), state: undefined });
      }
      const removedIds = removed.map(requestOf).filter(Boolean);
      if (data.outcome === 'canceled') {
        explicit = removedIds;
        kind = 'cancelled';
        // outcome:canceled also records queue edit/steer. Decide terminality after replay.
      } else if (removedIds.length && currentTurn !== undefined) {
        for (const id of removedIds) {
          turnRequests.get(currentTurn).add(id);
          requests.set(id, { ...requests.get(id), requestId: id, accepted: true, turnId: turnId(sessionId, currentTurn) });
        }
        explicit = removedIds;
        kind = 'started';
      } else {
        explicit = insertedIds;
        kind = 'accepted';
      }
    } else if (raw.type === 'user/message') {
      const id = requestOf(data);
      if (id) {
        explicit = [id];
        lastAdmission.set(id, raw.seq);
        requests.set(id, { ...requests.get(id), requestId: id, accepted: true, promptText: textOf(data), ...(currentTurn === undefined ? {} : { turnId: turnId(sessionId, currentTurn) }) });
        if (currentTurn !== undefined) turnRequests.get(currentTurn).add(id);
      }
    } else if (raw.type === 'turn/start') kind = 'started';
    else if (raw.type === 'turn/end') kind = data.reason?.kind === 'completed' && !stepped.has(currentTurn) ? 'failed' : endType(data.reason);
    else if (raw.type === 'approval/asked' || (raw.type === 'tool/call' && data.name === 'ask_user_question') || (raw.type === 'tool/ptc-dispatch' && data.name === 'ask_user_question')) kind = 'waiting_input';
    if (raw.type === 'assistant/message' && !data.interrupted) {
      const content = data.message?.content ?? data.content;
      if (Array.isArray(content) && !content.some(block => block?.type === 'tool-call')) assistantFinals.set(currentTurn, textOf(data));
    }
    annotated.push({ raw, explicit, turn: kind === 'accepted' || (kind === 'cancelled' && raw.type === 'agent/inbox/spliced') ? undefined : currentTurn, kind });
    if (raw.type === 'turn/end') currentTurn = undefined;
  }
  const output = [];
  for (const { raw, explicit, turn, kind } of annotated) {
    const ids = explicit ?? [...(turnRequests.get(turn) ?? [])];
    for (const requestId of ids) {
      const actualKind = kind === 'cancelled' && raw.type === 'agent/inbox/spliced' && (lastAdmission.get(requestId) ?? -1) >= raw.seq ? 'progress' : kind;
      const data = raw.data ?? {};
      const text = raw.type === 'turn/end' ? assistantFinals.get(turn) : raw.type === 'assistant/message' ? textOf(data) : undefined;
      const error = kind === 'failed' ? data.reason?.kind === 'completed' ? 'Harness completed without reaching a step; claimed request was not executed' : data.reason?.error?.message ?? `Harness turn ended: ${data.reason?.kind ?? 'unknown'}` : undefined;
      const event = {
        seq: raw.seq, requestId,
        ...(turn === undefined ? {} : { turnId: turnId(sessionId, turn), nativeTurn: turn }),
        type: actualKind, rawType: raw.type, data: raw.data,
        ...(text ? { text } : {}), ...(error ? { error } : {}),
        ...(typeof raw.time === 'number' ? { timestamp: new Date(raw.time).toISOString() } : {}), raw,
      };
      output.push(event);
      if (raw.type === 'turn/end' || actualKind === 'cancelled') requests.set(requestId, { ...requests.get(requestId), state: actualKind, ...(event.turnId ? { turnId: event.turnId } : {}) });
    }
  }
  return { events: output, requests, cursor: events.at(-1)?.seq ?? -1, activeRequests: currentTurn === undefined ? [] : [...(turnRequests.get(currentTurn) ?? [])] };
}
export function eventPage(replay, { requestId, afterSeq = -1, limit = 100 }) {
  const available = replay.events.filter(e => e.seq > afterSeq && (!requestId || e.requestId === requestId));
  const events = available.slice(0, limit);
  // A shared native seq can belong to multiple claimed requests. Do not split it.
  while (events.length < available.length && available[events.length].seq === events.at(-1)?.seq) events.push(available[events.length]);
  // Do not advance past undisclosed matching records. The native seq is zero-based.
  const cursor = available.length > events.length ? events.at(-1)?.seq ?? afterSeq : Math.max(afterSeq, replay.cursor);
  return { events, cursor, hasMore: available.length > events.length };
}

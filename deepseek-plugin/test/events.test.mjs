import test from 'node:test';
import assert from 'node:assert/strict';
import { replayEvents, eventPage } from '../events.mjs';
const message = id => ({ id: `message-${id}`, content: [{ type: 'text', text: `prompt ${id}` }], source: { kind: 'user', rpcId: id } });
const log = rows => rows.map(([type, data], seq) => ({ seq, type, data, time: 1700000000000 + seq }));
const insert = id => ['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message(id)] }];
const claim = () => ['agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }];
const assistant = text => ['assistant/message', { message: { content: [{ type: 'text', text }] } }];
test('real inbox claim binds the native turn and completion carries assistant text', () => {
  const raw = log([insert('a'), ['turn/start', { turn: 1 }], claim(), ['step/start', { turn: 1, step: 1 }], ['user/message', message('a')], assistant('actual result'), ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]);
  const replay = replayEvents('session-one', raw);
  assert.equal(replay.events[0].type, 'accepted'); assert.equal(replay.events[0].turnId, undefined);
  assert.equal(replay.events.at(-1).type, 'completed'); assert.equal(replay.events.at(-1).text, 'actual result');
  assert.equal(replay.events.at(-1).turnId, 'session-one:turn:1');
  assert.equal(replay.events.at(-1).raw, raw.at(-1));
  assert.equal(replay.requests.get('a').state, 'completed');
});
test('queued request never inherits prior request ending; repeated replay restores ownership', () => {
  const raw = log([insert('a'), ['turn/start', { turn: 1 }], claim(), insert('b'), ['step/start', { turn: 1, step: 1 }], assistant('a final'), ['turn/end', { turn: 1, reason: { kind: 'completed' } }], ['turn/start', { turn: 2 }], claim(), ['step/start', { turn: 2, step: 1 }], assistant('b final'), ['turn/end', { turn: 2, reason: { kind: 'completed' } }]]);
  const replay = replayEvents('s', raw);
  const b = replay.events.filter(e => e.requestId === 'b');
  assert.equal(b[0].turnId, undefined); assert.equal(b.filter(e => e.type === 'completed').length, 1);
  assert.equal(b.at(-1).turnId, 's:turn:2'); assert.equal(b.at(-1).text, 'b final');
  const one = eventPage(replay, { requestId: 'b', limit: 1 });
  assert.equal(one.cursor, 3); assert.equal(one.hasMore, true);
  const rest = eventPage(replay, { requestId: 'b', afterSeq: one.cursor, limit: 100 });
  assert.equal(rest.events.at(-1).type, 'completed'); assert.equal(rest.cursor, raw.at(-1).seq);
});
test('native stop, error, max tokens and dropped inbox have distinct terminal evidence', () => {
  for (const [reason, expected] of [[{ kind: 'aborted', reason: { kind: 'user' } }, 'cancelled'], [{ kind: 'error', error: { message: 'bad model' } }, 'failed'], [{ kind: 'max-tokens' }, 'failed'], [{ kind: 'interrupted' }, 'failed']]) {
    const replay = replayEvents('s', log([insert('a'), ['turn/start', { turn: 1 }], claim(), ['turn/end', { turn: 1, reason }]]));
    assert.equal(replay.events.at(-1).type, expected);
  }
  const cancelled = replayEvents('s', log([insert('a'), ['agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled', inserted: [] }]]));
  assert.equal(cancelled.events.at(-1).type, 'cancelled'); assert.equal(cancelled.events.at(-1).turnId, undefined);
});
test('permission and user questions wait without any synthetic completion', () => {
  const replay = replayEvents('s', log([insert('a'), ['turn/start', { turn: 1 }], claim(), ['approval/asked', { id: 'approval-a' }], ['tool/call', { name: 'ask_user_question' }]]));
  assert.equal(replay.events.filter(e => e.type === 'waiting_input').length, 2);
  assert.equal(replay.events.some(e => e.type === 'completed'), false);
  assert.deepEqual(replay.activeRequests, ['a']);
});
test('completed no-op and tool-call text cannot invent a final assistant report', () => {
  const replay = replayEvents('s', log([insert('a'), ['turn/start', { turn: 1 }], claim(), ['user/message', message('a')], ['assistant/message', { message: { content: [{ type: 'text', text: 'working' }, { type: 'tool-call', name: 'bash' }] } }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]));
  assert.equal(replay.events.at(-1).text, undefined);
});

test('claimed input with no executed step never reads as a successful task', () => {
  const replay = replayEvents('s', log([insert('a'), ['turn/start', { turn: 1 }], claim(), ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]));
  assert.equal(replay.events.at(-1).type, 'failed');
  assert.match(replay.events.at(-1).error, /without reaching a step/);
});
test('queue replacement preserves the same request without a false cancelled ending', () => {
  const raw = log([insert('a'), ['agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled', inserted: [message('a')] }], ['turn/start', { turn: 1 }], claim(), ['step/start', { turn: 1, step: 1 }], assistant('final'), ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]);
  const replay = replayEvents('s', raw);
  assert.equal(replay.events.some(e => e.type === 'cancelled'), false);
  assert.equal(replay.events.at(-1).type, 'completed');
});
test('queue steer remove+reinsert is progress until the actual consuming turn ends', () => {
  const raw = log([insert('a'), ['agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled', inserted: [] }], ['agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message('a')] }], ['turn/start', { turn: 1 }], ['agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }], ['step/start', { turn: 1, step: 1 }], assistant('final'), ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]);
  const replay = replayEvents('s', raw);
  assert.equal(replay.events.some(e => e.type === 'cancelled'), false);
  assert.equal(replay.events.at(-1).type, 'completed');
});

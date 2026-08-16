/**
 * The write-back mapping is the part of this plugin another project's code
 * reads: memU classifies what we write, so these tests pin the exact record
 * shapes its dialect sniffer buckets as conversation and as tool traffic.
 *
 * `tests/classify_check.py` runs the same fixtures through memU's real
 * classifier; keep the two in step.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toMemuRecord } from '../lib/index.js'

const LIMITS = { maxToolResultChars: 40 }
const TIME = Date.parse('2026-08-16T12:00:00.000Z')

/** A session event envelope with the fields the mapping reads. */
function event(type, data) {
  return { type, seq: 1, time: TIME, data }
}

test('a typed user message becomes a user-role text record', () => {
  const record = toMemuRecord(
    event('user/message', {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'always deploy with the staging flag first' }],
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(record.type, 'user')
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(record.host, 'dsh')
  assert.equal(record.timestamp, '2026-08-16T12:00:00.000Z')
  assert.deepEqual(record.message.content, [
    { type: 'text', text: 'always deploy with the staging flag first' },
  ])
})

test('plugin-injected and tool-sourced user messages are not mirrored', () => {
  // This is what stops the plugin feeding memU its own retrieval output.
  const injected = toMemuRecord(
    event('user/message', {
      id: 'm2',
      role: 'user',
      source: { kind: 'plugin', plugin: 'personal-memory' },
      content: [{ type: 'text', text: 'retrieved memory: …' }],
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(injected, null)

  const fromTool = toMemuRecord(
    event('user/message', {
      id: 'm3',
      role: 'user',
      source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'text', text: 'tool output' }],
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(fromTool, null)
})

test('assistant reasoning is dropped, visible text is kept', () => {
  const record = toMemuRecord(
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model' },
        content: [
          { type: 'reasoning', text: 'the user probably means staging' },
          { type: 'text', text: 'Deploying to staging.' },
        ],
      },
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(record.type, 'assistant')
  assert.deepEqual(record.message.content, [{ type: 'text', text: 'Deploying to staging.' }])
})

test('an empty assistant message produces no record', () => {
  const record = toMemuRecord(
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a2', role: 'assistant', source: { kind: 'model' }, content: [] },
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(record, null)
})

test('a tool call becomes its own assistant record carrying tool_use', () => {
  // Separate from the assistant turn on purpose: a record holding both text and
  // tool_use classifies as conversation, and memU's skill job loses the trace.
  const record = toMemuRecord(
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-7',
      name: 'bash',
      arguments: '{"command":"pnpm build"}',
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(record.type, 'assistant')
  assert.deepEqual(record.message.content, [
    { type: 'tool_use', id: 'call-7', name: 'bash', input: { command: 'pnpm build' } },
  ])
})

test('unparseable tool arguments are kept verbatim', () => {
  const record = toMemuRecord(
    event('tool/call', { turn: 1, step: 1, callId: 'call-8', name: 'bash', arguments: '{"command":' }),
    'sess-1',
    LIMITS,
  )
  assert.equal(record.message.content[0].input, '{"command":')
})

test('a tool result becomes a user record carrying tool_result, clipped', () => {
  const record = toMemuRecord(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-7' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-7',
          isError: true,
          content: [{ type: 'text', text: 'x'.repeat(200) }],
        }],
      },
    }),
    'sess-1',
    LIMITS,
  )
  assert.equal(record.type, 'user')
  const block = record.message.content[0]
  assert.equal(block.type, 'tool_result')
  assert.equal(block.tool_use_id, 'call-7')
  assert.equal(block.is_error, true)
  assert.ok(block.content.startsWith('x'.repeat(40)))
  assert.match(block.content, /truncated by dsh-personal-memory at 40 characters/)
})

test('non-memorable events map to nothing', () => {
  for (const type of ['turn/start', 'turn/end', 'step/start', 'assistant/chunk', 'todo/write']) {
    assert.equal(toMemuRecord(event(type, {}), 'sess-1', LIMITS), null, type)
  }
})

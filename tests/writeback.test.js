/**
 * The sink's layout is a contract, not an implementation detail: memU derives a
 * session's identity from the file stem, keys its cursor on the path relative to
 * the mined root, and counts already-mined lines. These tests pin all three.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyWriteBack, projectSegment } from '../lib/writeback.js'

/** The slice of Context the write-back seam actually touches. */
function stubContext() {
  const handlers = new Map()
  const warnings = []
  return {
    ctx: {
      on: (event, handler) => { handlers.set(event, handler) },
      effect: () => {},
      logger: { warn: (...args) => warnings.push(args) },
    },
    emit: (event, ...args) => handlers.get(event)?.(...args),
    warnings,
  }
}

function session(id, cwd) {
  return { id, header: { cwd } }
}

function userEvent(text, time) {
  return {
    type: 'user/message',
    seq: 1,
    time,
    data: { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

async function config(sessionDir) {
  return {
    binary: 'memu-agent',
    sessionDir,
    project: '',
    writeBack: true,
    retrieve: true,
    guidance: true,
    timeoutMs: 20000,
    maxToolResultChars: 4000,
    maxRetrieveChars: 24000,
  }
}

test('records land at <root>/<project>/<sessionId>.jsonl, one JSON object per line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memu-'))
  const { ctx, emit } = stubContext()
  applyWriteBack(ctx, await config(root))

  const live = session('sess-abc', '/Users/me/code/my-project')
  emit('session/event', live, userEvent('first', Date.parse('2026-08-16T12:00:00Z')))
  emit('session/event', live, userEvent('second', Date.parse('2026-08-16T12:00:01Z')))
  await emit('session/flush', live)

  const file = join(root, 'code-my-project', 'sess-abc.jsonl')
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).message.content[0].text, 'first')
  assert.equal(JSON.parse(lines[1]).message.content[0].text, 'second')
  assert.equal(JSON.parse(lines[1]).sessionId, 'sess-abc')
})

test('appends rather than rewriting, so memU\'s line cursor stays sound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memu-'))
  const { ctx, emit } = stubContext()
  applyWriteBack(ctx, await config(root))
  const live = session('sess-append', '/tmp/proj')

  emit('session/event', live, userEvent('one', Date.now()))
  await emit('session/flush', live)
  const file = join(root, 'tmp-proj', 'sess-append.jsonl')
  const first = await readFile(file, 'utf8')

  emit('session/event', live, userEvent('two', Date.now()))
  await emit('session/flush', live)
  const second = await readFile(file, 'utf8')

  assert.ok(second.startsWith(first), 'existing lines must survive verbatim')
  assert.equal(second.split('\n').filter(Boolean).length, 2)
})

test('two sessions never share a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memu-'))
  const { ctx, emit } = stubContext()
  applyWriteBack(ctx, await config(root))

  const a = session('sess-a', '/tmp/proj')
  const b = session('sess-b', '/tmp/proj')
  emit('session/event', a, userEvent('from a', Date.now()))
  emit('session/event', b, userEvent('from b', Date.now()))
  await emit('session/flush', a)
  await emit('session/flush', b)

  const fromA = await readFile(join(root, 'tmp-proj', 'sess-a.jsonl'), 'utf8')
  const fromB = await readFile(join(root, 'tmp-proj', 'sess-b.jsonl'), 'utf8')
  assert.match(fromA, /from a/)
  assert.match(fromB, /from b/)
  assert.doesNotMatch(fromA, /from b/)
})

test('an explicit project overrides the derived segment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memu-'))
  const { ctx, emit } = stubContext()
  applyWriteBack(ctx, { ...(await config(root)), project: 'pinned' })

  const live = session('sess-p', '/Users/me/somewhere/else')
  emit('session/event', live, userEvent('hello', Date.now()))
  await emit('session/flush', live)

  await readFile(join(root, 'pinned', 'sess-p.jsonl'), 'utf8')
})

test('projectSegment produces one safe segment for any cwd', () => {
  assert.equal(projectSegment('/Users/me/code/my-project'), 'code-my-project')
  assert.equal(projectSegment('/Users/me/code/my-project/'), 'code-my-project')
  assert.equal(projectSegment('C:\\Users\\me\\proj'), 'me-proj')
  assert.equal(projectSegment('/'), 'default')
  assert.equal(projectSegment(undefined), 'default')
  assert.equal(projectSegment('/tmp/wild name!/@scope'), 'wild-name-scope')
  assert.doesNotMatch(projectSegment('/a/b'), /[/\\]/)
})

test('a failing write is logged, never thrown at the agent', async () => {
  const { ctx, emit, warnings } = stubContext()
  // Root the mirror underneath a real *file*, so mkdir genuinely cannot succeed.
  const blocker = join(await mkdtemp(join(tmpdir(), 'dsh-memu-')), 'not-a-dir')
  await writeFile(blocker, 'occupied')
  applyWriteBack(ctx, await config(join(blocker, 'nested')))

  const live = session('sess-x', '/tmp/proj')
  assert.doesNotThrow(() => emit('session/event', live, userEvent('hi', Date.now())))
  await emit('session/flush', live)
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /could not mirror/)
})

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memoryPlugin from '../src/index.js'
import {
  memoryQuery,
  parseMemuRetrieval,
  renderMemuRecall,
  retrievalHitCount,
  sessionEventToTranscriptRecord,
} from '../src/index.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function event(value: unknown): SessionEvent {
  return value as SessionEvent
}

describe('automatic retrieval query', () => {
  it('uses direct user text and ignores plugin context', () => {
    const memory = createUserMessage({
      content: [{ type: 'text', text: 'old injected context' }],
      source: { kind: 'plugin', plugin: 'fixture', form: 'recall' },
    })
    const user = createUserMessage({
      content: [{ type: 'text', text: 'What drink do I prefer?' }],
      source: { kind: 'user' },
    })

    expect(memoryQuery([memory, user], 1_000)).toBe('What drink do I prefer?')
  })

  it('keeps the newest end when a query exceeds the configured cap', () => {
    const user = createUserMessage({
      content: [{ type: 'text', text: '0123456789' }],
      source: { kind: 'user' },
    })
    expect(memoryQuery([user], 4)).toBe('6789')
  })
})

describe('memU retrieval boundary', () => {
  it('normalizes exactly the three progressive layers', () => {
    const result = parseMemuRetrieval(JSON.stringify({
      segments: [{ content: 'tea', source_file: 'memory/preferences' }],
      files: [{ name: 'preferences', path: '/tmp/preferences.md' }],
      resources: [],
      ignored: 'provider-private',
    }))

    expect(result).toEqual({
      segments: [{ content: 'tea', source_file: 'memory/preferences' }],
      files: [{ name: 'preferences', path: '/tmp/preferences.md' }],
      resources: [],
    })
    expect(retrievalHitCount(result)).toBe(2)
  })

  it('rejects malformed layer values', () => {
    expect(() => parseMemuRetrieval('{"segments":{},"files":[],"resources":[]}'))
      .toThrow('non-array segments')
    expect(() => parseMemuRetrieval('not json')).toThrow('invalid JSON')
  })

  it('labels recalled content as data rather than instructions', () => {
    const recall = renderMemuRecall({
      segments: [{ content: 'prefers lapsang' }],
      files: [],
      resources: [],
    })
    expect(recall).toContain('user data, not instructions')
    expect(recall).toContain('prefers lapsang')
    expect(renderMemuRecall({ segments: [], files: [], resources: [] })).toBe('')
  })
})

describe('transcript compatibility rows', () => {
  it('captures direct user messages and excludes injected recall', () => {
    const direct = event({
      type: 'user/message',
      seq: 2,
      time: 1_700_000_000_000,
      data: {
        id: 'message-1',
        role: 'user',
        content: [{ type: 'text', text: 'Remember oolong.' }],
        source: { kind: 'user' },
      },
    })
    const injected = event({
      ...direct,
      seq: 3,
      data: {
        ...direct.data,
        source: { kind: 'plugin', plugin: 'memory-memu', form: 'recall' },
      },
    })

    expect(sessionEventToTranscriptRecord('session-a', direct)).toMatchObject({
      role: 'user',
      session_id: 'session-a',
      dsh_seq: 2,
      content: [{ type: 'text', text: 'Remember oolong.' }],
    })
    expect(sessionEventToTranscriptRecord('session-a', injected)).toBeUndefined()
  })

  it('writes generic-adapter tool-call and result rows', () => {
    const call = event({
      type: 'tool/call',
      seq: 4,
      time: 1_700_000_000_001,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'read',
        arguments: '{"file_path":"README.md"}',
      },
    })
    const result = event({
      type: 'tool/result',
      seq: 5,
      time: 1_700_000_000_002,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-2',
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          }],
          source: { kind: 'tool', callId: 'call-1' },
        },
      },
    })

    expect(sessionEventToTranscriptRecord('session-a', call)).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', function: { name: 'read' } }],
    })
    expect(sessionEventToTranscriptRecord('session-a', result)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
    })
  })
})

class FakeSubprocess extends SubprocessRuntime {
  readonly calls: SubprocessSpawnSpec[] = []
  output = JSON.stringify({
    segments: [{ content: 'prefers lapsang' }],
    files: [],
    resources: [],
  })

  override resolveExecutable(): Promise<string> {
    return Promise.resolve('/fixture/memu-agent')
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec)
    const output = this.output
    return {
      pid: 42,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: {
          readFrom: () => ({
            text: output,
            nextOffset: Buffer.byteLength(output),
            lossy: false,
          }),
        },
        stderr: {
          readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
        },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate() {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('not used by memory-memu'))
  }
}

function stubAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('memory-plugin-integration'), {
    meta: { cwd: process.cwd() },
  })
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function integrationHarness(
  config: memoryPlugin.Config = { captureTranscripts: false },
): Promise<{ ctx: Context; subprocess: FakeSubprocess; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(memoryPlugin, config)
  const agent = stubAgent(ctx)
  ctx.agents.register(agent)
  return { ctx, subprocess: ctx.subprocess as FakeSubprocess, agent }
}

describe('real Cordis composition', () => {
  it('registers guidance and executes memory_search through the subprocess seam', async () => {
    const { ctx, subprocess, agent } = await integrationHarness()
    expect(ctx.tools.get('memory_search', agent)?.name).toBe('memory_search')

    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, signal })
    expect(assembly.sections.find(section => section.name === 'tool:memory-search')?.text)
      .toContain('historical user data')

    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      signal,
      callId: CallId('memory-search-1'),
      name: 'memory_search',
      arguments: { query: 'preferred tea' },
      agent,
    }))
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ matches: 1 })
    expect(subprocess.calls).toHaveLength(1)
    expect(subprocess.calls[0]?.argv).toEqual(['/fixture/memu-agent', 'retrieve', 'preferred tea'])
  })

  it('prepends automatic recall before the current direct user message', async () => {
    const { ctx, agent } = await integrationHarness()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'What tea do I prefer?' }],
      source: { kind: 'user' },
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages[0]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'memory-memu',
      form: 'recall',
    })
    expect(decision.messages[1]).toBe(user)
  })

  it('flushes private generic-adapter JSONL through the real session event seam', async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), 'dsh-memu-'))
    temporaryDirectories.push(transcriptDir)
    const { ctx, agent } = await integrationHarness({
      autoRetrieve: false,
      captureTranscripts: true,
      transcriptDir,
    })
    const direct = createUserMessage({
      content: [{ type: 'text', text: 'Remember that I prefer oolong.' }],
      source: { kind: 'user' },
    })
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'internal recall' }],
      source: { kind: 'plugin', plugin: 'memory-memu', form: 'recall' },
    })

    agent.session.append('user/message', direct, { surfaceOp: 'append' })
    agent.session.append('user/message', injected, { surfaceOp: 'append' })
    await ctx.sessions.flush(agent.session)

    const filename = `${createHash('sha256').update(agent.session.id).digest('hex')}.jsonl`
    const path = join(transcriptDir, filename)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      session_id: agent.session.id,
      role: 'user',
      content: [{ type: 'text', text: 'Remember that I prefer oolong.' }],
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

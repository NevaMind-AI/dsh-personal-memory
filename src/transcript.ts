/**
 * The mapping half of the write-back seam: one dsh session event becomes at
 * most one memU transcript record.
 *
 * memU's generic adapter classifies each JSONL record by sniffing known
 * dialects, and the one it calls the "Claude Code lineage" is what this module
 * emits — `{"type": "user"|"assistant", "message": {"content": [blocks]}}`,
 * where the *block* type decides whether the record is conversation or tool
 * traffic. That distinction is load-bearing on memU's side: the memory job
 * reads conversation alone (what the user said they wanted) while the skill job
 * also reads tool calls (how the work was actually done). Emitting a tool call
 * as its own record rather than folding it into the assistant turn is what
 * keeps those two jobs separable — a record carrying both text and `tool_use`
 * classifies as conversation and the tool trace is lost to the skill job.
 *
 * Everything here is a pure function of the event. No I/O, no clock: the record
 * carries the event's own recorded time, so a replayed session mirrors to the
 * same bytes it did live.
 *
 * @module dsh-personal-memory/transcript
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A content block in the dialect memU sniffs, not dsh's own vocabulary. */
export type MemuBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/** One line of the mirrored JSONL transcript. */
export interface MemuRecord {
  /** The record's role tag. memU reads this before it reads the blocks. */
  type: 'user' | 'assistant'
  /** ISO-8601, from the event's own `time` — never from the wall clock. */
  timestamp: string
  /** The dsh session this record belongs to, mirroring the file's stem. */
  sessionId: string
  /** Producer tag, for a human reading the mirror. memU ignores it. */
  host: 'dsh'
  message: { role: 'user' | 'assistant'; content: MemuBlock[] }
}

/** Concatenate the readable text of a block list, dropping non-text blocks. */
function flattenText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Clip an over-long mirrored value, marking the cut so no reader mistakes it for the whole. */
function clip(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [truncated by dsh-personal-memory at ${limit} characters]`
}

/** Bounds applied while mirroring; see the matching {@link Config} fields. */
export interface TranscriptLimits {
  maxToolResultChars: number
}

/**
 * Map one session event onto its memU record.
 *
 * @param event - the appended event, exactly as recorded.
 * @param sessionId - the owning session's id, stamped on every record.
 * @param limits - mirroring bounds.
 * @returns the record to append, or null when the event is not memorable.
 */
export function toMemuRecord(
  event: SessionEvent,
  sessionId: string,
  limits: TranscriptLimits,
): MemuRecord | null {
  const timestamp = new Date(event.time).toISOString()
  const envelope = { timestamp, sessionId, host: 'dsh' as const }

  switch (event.type) {
    case 'user/message': {
      // Only what a human actually typed. Plugin-injected context (this
      // plugin's own retrieval results included) and tool results both arrive
      // as user-role messages; mirroring them would feed memU its own output
      // and let a standing instruction resurface as a remembered preference.
      if (event.data.source.kind !== 'user') return null
      const text = flattenText(event.data.content)
      if (!text) return null
      return { type: 'user', ...envelope, message: { role: 'user', content: [{ type: 'text', text }] } }
    }

    case 'assistant/message': {
      // Visible text only: reasoning is deliberately excluded. memU's own
      // adapters drop reasoning traces, and a thinking block is a draft, not a
      // statement the user ever saw or agreed to.
      const text = flattenText(event.data.message.content)
      if (!text) return null
      return {
        type: 'assistant',
        ...envelope,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }
    }

    case 'tool/call': {
      // `arguments` is the raw model-generated JSON string. Parsed when it
      // parses, kept verbatim when it does not — a malformed call is still
      // evidence of what the model tried.
      let input: unknown
      try {
        input = JSON.parse(event.data.arguments)
      } catch {
        input = event.data.arguments
      }
      return {
        type: 'assistant',
        ...envelope,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: String(event.data.callId), name: event.data.name, input }],
        },
      }
    }

    case 'tool/result': {
      const block = event.data.message.content[0]
      const text = clip(flattenText(block.content), limits.maxToolResultChars)
      return {
        type: 'user',
        ...envelope,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: String(block.toolCallId),
            content: text,
            ...(block.isError === true ? { is_error: true } : {}),
          }],
        },
      }
    }

    default:
      // Every other event type — boundaries, chunks, usage, approvals, this
      // plugin's own bookkeeping — is not conversation and not tool traffic.
      return null
  }
}

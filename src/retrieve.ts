/**
 * The retrieval (inject) seam — memory reaching the model.
 *
 * Two registrations, deliberately independent. The **tool** is the capability:
 * one call into memU's progressive retrieval. The **section** is the standing
 * instruction that makes the model reach for it before answering, adapted from
 * memU's own host instruction so a dsh user gets the same contract a Codex or
 * Claude Code user gets. Either can be turned off without the other: a
 * deployment that owns its prompt layer keeps the tool and drops the guidance.
 *
 * @module dsh-personal-memory/retrieve
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only, and load-bearing: this is the package whose declaration merging
// puts `systemPrompt` on `Context`. Erased at emit.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Config } from './config.ts'
import { retrieve } from './memu.ts'

/** The model-facing tool name, also referenced by the guidance section. */
export const TOOL_NAME = 'memory_search'

/**
 * The standing instruction. Adapted from memU's `RETRIEVAL_BODY`, which
 * describes the three-layer result the tool returns; the shell command is
 * replaced by the tool call, and nothing about the layers is restated
 * differently, because that shape is memU's contract, not this plugin's.
 */
export const GUIDANCE = `## memU — retrieve before answering

Before answering, call \`${TOOL_NAME}\` with the user's request — reworded into a
clearer query or focused keywords when that retrieves better (you need not pass
their raw words verbatim). Use any relevant results as context. If it returns
nothing, proceed normally.

The result unfolds progressively, in three layers. \`segments\` are the narrowest
and usually the most on-point: the individual slices of memory that matched the
query, each naming in \`source_file\` the document it was cut from. \`files\` are
those synthesized documents — broader, and worth consulting when a segment reads
as relevant but is too thin to act on; find one by matching a segment's
\`source_file\` to it. Each file gives you a summary plus either a \`path\` to open
when you need the full text or, if its file is unavailable, the text inline.
\`resources\` are files on the user's own machine that look related, each a \`path\`
plus a summary. Work from the summaries; open a \`path\` only when you need what it
leaves out.`

/**
 * Mount the retrieval seam for the lifetime of `ctx`.
 *
 * @param ctx - plugin context; both registrations are disposed with it.
 * @param config - resolved plugin configuration.
 */
export function applyRetrieve(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Search the user\'s durable memory (memU) for anything already known about this '
      + 'request — their preferences, decisions, and skills learned from earlier sessions '
      + 'across every connected agent. Cheap, LLM-free, and fails open: an empty result '
      + 'means nothing was stored, not that the search failed.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Natural-language query. Focused keywords often retrieve better than a verbatim request.',
      },
    },
    output: {
      // memU owns this shape; declaring it as JSON hands the model and Code Mode
      // the real structure instead of prose they would have to parse back.
      schema: { type: 'json' },
      render: (_args, value) => {
        const text = JSON.stringify(value, null, 2)
        // The bound applies to what the model reads. Code Mode still receives
        // the complete canonical value, which is never truncated.
        const bounded = text.length > config.maxRetrieveChars
          ? `${text.slice(0, config.maxRetrieveChars)}\n… [truncated by dsh-personal-memory at ${config.maxRetrieveChars} characters]`
          : text
        return [{ type: 'text', text: bounded }]
      },
    },
    async execute(args, exec) {
      const query = args.query.trim()
      if (!query) throw new Error('query must not be empty.')
      return retrieve(query, {
        binary: config.binary,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      })
    },
  }))

  if (config.guidance) {
    // 100–199 is the tool-guidance band; this is guidance about a tool, so it
    // belongs beside the built-in tools' own sections rather than above them.
    ctx.systemPrompt.section({ name: 'memory:memu', order: 150, text: GUIDANCE })
  }
}

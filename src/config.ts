/**
 * Plugin configuration. Every value two deployments might set differently is a
 * field here; nothing about the memU binary, its layout, or its limits is
 * hardcoded in the seams themselves.
 *
 * @module dsh-personal-memory/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Where memU lives and how the two seams behave. */
export interface Config {
  /**
   * The memU host-adapter binary. `memu-agent` is the generic adapter, which
   * reads any JSONL session log whose dialect it recognizes — including the one
   * {@link module:dsh-personal-memory/transcript} writes. Point this at a
   * dedicated binary (`memu-claude-code`, …) only to share one machine's store
   * with that host's own tree.
   */
  binary: string
  /**
   * Absolute or `~`-relative directory holding the write-back mirror. This is
   * the `--session-dir` the memU bridging task mines, so changing it here means
   * changing it in the scheduled task too.
   */
  sessionDir: string
  /**
   * Subdirectory under {@link sessionDir} that groups one project's sessions.
   * Empty means derive it from the session's own working directory, which is
   * what keeps two checkouts from writing into one tree.
   */
  project: string
  /** Register the write-back (record) seam: mirror live sessions as memU JSONL. */
  writeBack: boolean
  /** Register the retrieval (inject) seam: the `memory_search` tool. */
  retrieve: boolean
  /**
   * Register the standing instruction that tells the model to search memory
   * before answering. Turn this off to keep the tool while owning the guidance
   * from your own prompt layer.
   */
  guidance: boolean
  /** Milliseconds a single `retrieve` call may take before it is killed. */
  timeoutMs: number
  /**
   * Bound on one mirrored tool result, in characters. A memU job wants to see
   * that a command ran and roughly what it returned, not a 40k-line build log.
   */
  maxToolResultChars: number
  /**
   * Bound on the JSON `memory_search` hands the model, in characters. memU's
   * progressive retrieval already returns locations rather than full files, so
   * this is a backstop against a pathological store, not routine truncation.
   */
  maxRetrieveChars: number
}

/** Schemastery validation for {@link Config}. Defaults are the shipped behavior. */
export const Config: Schema<Config> = Schema.object({
  binary: Schema.string().default('memu-agent'),
  sessionDir: Schema.string().default('~/.dsh/memu-sessions'),
  project: Schema.string().default(''),
  writeBack: Schema.boolean().default(true),
  retrieve: Schema.boolean().default(true),
  guidance: Schema.boolean().default(true),
  timeoutMs: Schema.number().default(20_000),
  maxToolResultChars: Schema.number().default(4_000),
  maxRetrieveChars: Schema.number().default(24_000),
})

/**
 * Personal memory for DeepSeek Harness, backed by memU.
 *
 * memU gives an agent two seams. **Record**: session history flows out and is
 * distilled into durable memory and reusable skills. **Inject**: that memory
 * flows back in before the agent answers. This plugin binds both to dsh — the
 * write-back hook mirrors live sessions into memU's mined layout, and the
 * retrieval tool queries the same store the user's other agents write to.
 *
 * The two are independent. Retrieval alone makes dsh a reader of memory other
 * agents wrote; write-back alone makes dsh a contributor to a store other
 * agents read. Both is the loop.
 *
 * @module dsh-personal-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { applyRetrieve } from './retrieve.ts'
import { applyWriteBack } from './writeback.ts'

export { Config }
export type { MemuBlock, MemuRecord } from './transcript.ts'
export { toMemuRecord } from './transcript.ts'
export { GUIDANCE, TOOL_NAME } from './retrieve.ts'
export { MemuError, retrieve } from './memu.ts'
export { expandHome, projectSegment } from './writeback.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'personal-memory'

/**
 * Services both seams need. Declared unconditionally rather than per-seam
 * because Cordis resolves `inject` before `apply` runs and cannot see config;
 * a deployment that disables a seam still loads inside a harness that has these.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * Mount the configured seams for the lifetime of `ctx`.
 *
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - validated configuration, defaults already filled.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.retrieve) applyRetrieve(ctx, config)
  if (config.writeBack) applyWriteBack(ctx, config)
}

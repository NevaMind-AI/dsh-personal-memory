/**
 * The memU process boundary. Everything that shells out to a memU binary lives
 * here, so the seams above stay pure policy.
 *
 * memU deliberately exposes retrieval through the *host adapter binary* rather
 * than a library call, because that binary is what a host's hook can reliably
 * invoke. dsh is such a host, so this plugin is such a hook: `retrieve` runs
 * memU's LLM-free progressive retrieval — one embedding of the query, then
 * ranked segment/file/resource layers back — which is cheap enough to sit on a
 * per-turn path.
 *
 * @module dsh-personal-memory/memu
 */

import { execFile } from 'node:child_process'
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** A failure that should reach the model as an actionable message. */
export class MemuError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MemuError'
  }
}

/** Options for one {@link retrieve} call. */
export interface RetrieveOptions {
  /** The memU host-adapter binary to invoke. */
  binary: string
  /** Milliseconds before the child is killed. */
  timeoutMs: number
  /** Caller cancellation — the tool's own `exec.signal`. */
  signal: AbortSignal
}

/** Node attaches a `code` to spawn failures; narrow it without asserting a shape. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

/**
 * Run memU's progressive retrieval for one query.
 *
 * @param query - natural-language query, passed to memU verbatim.
 * @param options - binary, bounds, and cancellation.
 * @returns memU's result, parsed but otherwise exactly as memU shaped it.
 * @throws MemuError when memU is absent, fails, times out, or returns non-JSON.
 */
export async function retrieve(query: string, options: RetrieveOptions): Promise<JsonValue> {
  const stdout = await new Promise<string>((settle, reject) => {
    execFile(
      options.binary,
      ['retrieve', query],
      {
        timeout: options.timeoutMs,
        signal: options.signal,
        // memU already returns locations rather than file bodies, so this bound
        // exists to stop a pathological store, not to trim ordinary results.
        maxBuffer: 8_000_000,
        encoding: 'utf8',
      },
      (error, out, errorOutput) => {
        if (error === null) return settle(out)
        const code = errorCode(error)
        if (code === 'ENOENT') {
          return reject(new MemuError(
            `memU binary '${options.binary}' was not found. Install it with `
            + `\`pip install memu-cli\` (or \`uvx --from memu-cli\`), then run `
            + `\`${options.binary} doctor\` to verify the store is reachable.`,
            { cause: error },
          ))
        }
        if (code === 'ABORT_ERR' || options.signal.aborted) {
          return reject(new MemuError('memory search was cancelled.', { cause: error }))
        }
        // A killed child reports its signal rather than an exit status.
        if ('killed' in error && error.killed === true) {
          return reject(new MemuError(
            `memU retrieval exceeded ${options.timeoutMs}ms.`,
            { cause: error },
          ))
        }
        return reject(new MemuError(
          `memU retrieval failed: ${errorOutput.trim() || error.message}`,
          { cause: error },
        ))
      },
    )
  })

  const text = stdout.trim()
  // An empty store is a successful retrieval that found nothing, not a failure:
  // the standing instruction promises the seam fails open.
  if (!text) return { segments: [], files: [], resources: [] }
  try {
    // Handed on exactly as memU shaped it. Reshaping here would fork the
    // contract its own standing instruction describes to the model.
    return JSON.parse(text) as JsonValue
  } catch (error: unknown) {
    throw new MemuError(
      `memU returned output that is not JSON. Run \`${options.binary} doctor\` to check the configured backend.`,
      { cause: error },
    )
  }
}

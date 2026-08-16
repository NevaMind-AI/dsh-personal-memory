/**
 * The write-back (record) seam — the hook that flows dsh sessions back to memU.
 *
 * dsh keeps its session log in memory and leaves persistence to plugins; memU
 * mines session logs *from disk*. This module is the bridge: it subscribes to
 * the post-commit `session/event` feed and mirrors the memorable events into an
 * append-only JSONL file per session, laid out exactly as memU's incremental
 * cursor expects.
 *
 * Two invariants make that cursor sound, and both are enforced here:
 *
 *  1. **Append-only.** memU stages a per-session cursor counting lines already
 *     mined. Rewriting or compacting a mirrored file would silently re-mine or
 *     skip records, so this sink only ever appends.
 *  2. **One file per session, named by session id.** memU derives a session's
 *     identity from the file stem and its cursor key from the path relative to
 *     the mined root, so the layout is part of the contract, not a convenience.
 *
 * Failure is contained by construction. A mirror that cannot be written must
 * never fail the agent that produced the event, so every I/O error is logged
 * and dropped; the seam degrades to "no new memory", never to a broken turn.
 *
 * @module dsh-personal-memory/writeback
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import { toMemuRecord } from './transcript.ts'

/** Expand a leading `~` against the current user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Reduce a path to one filesystem-safe directory segment.
 *
 * The result only has to be stable and collision-resistant enough to keep two
 * checkouts apart; it is never parsed back into a path.
 */
export function projectSegment(cwd: string | undefined): string {
  if (!cwd) return 'default'
  const cleaned = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).slice(-2).join('-')
  const safe = cleaned.replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'default'
}

/**
 * Mount the write-back hook for the lifetime of `ctx`.
 *
 * @param ctx - plugin context; the subscription is disposed with it.
 * @param config - resolved plugin configuration.
 */
export function applyWriteBack(ctx: Context, config: Config): void {
  const root = resolve(expandHome(config.sessionDir))
  // One serialized append chain per session. `session/event` is fire-and-forget
  // and can re-enter before an await settles, so without this two appends can
  // interleave mid-line and corrupt the JSONL.
  const chains = new Map<string, Promise<void>>()
  // Directories are created once per session, not once per record.
  const prepared = new Set<string>()

  const pathFor = (session: Session): string => {
    const project = config.project || projectSegment(session.header.cwd)
    return join(root, project, `${String(session.id)}.jsonl`)
  }

  const enqueue = (file: string, line: string): void => {
    const previous = chains.get(file) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (!prepared.has(file)) {
        await mkdir(dirname(file), { recursive: true })
        prepared.add(file)
      }
      await appendFile(file, line, 'utf8')
    }).catch((error: unknown) => {
      // Contained on purpose: the agent's turn does not depend on its mirror.
      ctx.logger.warn('dsh-personal-memory: could not mirror to %s: %s', file, String(error))
    })
    chains.set(file, next)
  }

  ctx.on('session/event', (session, event) => {
    const record = toMemuRecord(event, String(session.id), {
      maxToolResultChars: config.maxToolResultChars,
    })
    if (record === null) return
    enqueue(pathFor(session), `${JSON.stringify(record)}\n`)
  })

  // The awaited durability checkpoint: drain what this session has queued so a
  // caller that flushed can trust the mirror is on disk.
  ctx.on('session/flush', async (session) => {
    await chains.get(pathFor(session))
  })

  // Disposal drains everything still in flight, for the same reason.
  ctx.effect(() => () => {
    void Promise.allSettled([...chains.values()])
  })
}

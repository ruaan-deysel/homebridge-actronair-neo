import type { StatusTree } from './schemas.js'
import { getPath, setPath } from './paths.js'
import { validateDeltaValue } from './schemas.js'

export type ChangeListener = (changedPaths: Set<string>) => void

/** Delta keys that are metadata, not state. */
const DELTA_METADATA_KEYS = new Set(['type'])

/** Why a single path/value pair in a delta was not applied. */
export interface DeltaRejection {
  path: string
  reason: string
}

/**
 * Result of applyDelta(). `ok` is what callers use to decide whether to trigger a REST
 * resync (mirrors the old boolean return); `rejected` names every path that stopped the
 * delta from applying and why, so a log line can say which field the cloud sent that this
 * plugin doesn't understand or couldn't parse.
 *
 * `ignored` is separate and does NOT affect `ok`: live broker capture shows every real
 * status-change broadcast bundles fields this plugin doesn't consume (damper position,
 * outdoor room temp, etc) alongside ones it does. That's normal cloud traffic, not a
 * malformed message — worth a debug log line to spot new upstream fields, not a resync.
 */
export interface ApplyDeltaResult {
  ok: boolean
  rejected: DeltaRejection[]
  ignored: string[]
}

/**
 * The authoritative device state.
 *
 * Release 1 feeds this from REST polling via replace(). Release 2 adds MQTT: full-status
 * also calls replace(), status-change calls applyDelta(). Accessories subscribe to change
 * events, so they are unaware of which transport produced the update.
 */
export class NeoState {
  private tree?: StatusTree
  private online = false
  private readonly listeners = new Set<ChangeListener>()

  get ready(): boolean {
    return this.tree !== undefined
  }

  get cloudConnected(): boolean {
    return this.online
  }

  setCloudConnected(value: boolean): void {
    this.online = value
  }

  snapshot(): StatusTree | undefined {
    return this.tree
  }

  get<T = unknown>(path: string): T | undefined {
    return this.tree ? getPath<T>(this.tree, path) : undefined
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Wholesale replacement from a REST poll or an MQTT full-status. */
  replace(next: StatusTree): void {
    const changed = this.tree ? diffPaths(this.tree, next) : new Set<string>(['*'])
    this.tree = next
    if (changed.size)
      this.emit(changed)
  }

  /**
   * Patch by dotted/bracketed path. This is the MQTT delta boundary: status-change payloads
   * are untrusted network input (`Record<string, unknown>`), so every path is checked
   * against the allowlist in schemas.ts and every value validated (or coerced, per the same
   * rule REST already uses) against its expected type before anything is written.
   *
   * Two distinct failure classes, per live broker capture: real broadcasts routinely bundle
   * fields this plugin doesn't consume (unknown path) alongside ones it does. That's normal
   * traffic — it's skipped and reported in `ignored`, but does NOT block the rest of the
   * delta or set `ok: false`. A known path with a value that doesn't fit its expected type
   * is a real problem — that rejects the *whole* delta (see `rejected`), because a partial
   * apply could leave correlated HVAC fields inconsistent (mode from one snapshot, setpoints
   * from another).
   *
   * All-or-nothing applies to the fields the plugin actually tracks: they're validated first,
   * then applied to a copy of the tree which only replaces the live tree if every one of
   * those paths applied cleanly.
   */
  applyDelta(delta: Record<string, unknown>): ApplyDeltaResult {
    if (!this.tree)
      return { ok: false, rejected: [], ignored: [] }

    const rejected: DeltaRejection[] = []
    const ignored: string[] = []
    const pending: Array<[string, unknown]> = []

    for (const [path, rawValue] of Object.entries(delta)) {
      if (DELTA_METADATA_KEYS.has(path))
        continue

      const validated = validateDeltaValue(path, rawValue)
      if (!validated.ok) {
        if (validated.kind === 'unknown-path')
          ignored.push(path)
        else
          rejected.push({ path, reason: validated.reason })
        continue
      }

      const current = getPath(this.tree, path)
      if (equal(current, validated.value))
        continue

      pending.push([path, validated.value])
    }

    if (rejected.length > 0)
      return { ok: false, rejected, ignored }

    if (pending.length === 0)
      return { ok: true, rejected: [], ignored }

    // Apply to a copy so a mid-delta traversal failure (e.g. an allowlisted path whose
    // concrete index doesn't exist) never leaves the live tree half-updated.
    const next = structuredClone(this.tree)
    const changed = new Set<string>()

    for (const [path, value] of pending) {
      if (setPath(next, path, value))
        changed.add(path)
      else
        rejected.push({ path, reason: 'path could not be traversed' })
    }

    if (rejected.length > 0)
      return { ok: false, rejected, ignored }

    this.tree = next
    if (changed.size)
      this.emit(changed)

    return { ok: true, rejected: [], ignored }
  }

  private emit(changed: Set<string>): void {
    for (const listener of this.listeners) {
      try {
        listener(changed)
      }
      catch {
        // A misbehaving accessory must not stop the others from updating.
      }
    }
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b)
    return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  return false
}

/** Leaf-level diff, producing the same dotted/bracketed paths applyDelta accepts. */
function diffPaths(a: unknown, b: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++)
      diffPaths(a[i], b[i], `${prefix}[${i}]`, out)
    return out
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key, out)
    return out
  }

  if (a !== b && prefix)
    out.add(prefix)
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

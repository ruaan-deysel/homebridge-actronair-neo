type Indexable = Record<string, unknown> | unknown[]

/**
 * Split a Neo path into segments. Neo uses the same notation for commands and for
 * status-change deltas: `UserAirconSettings.Mode`, `RemoteZoneInfo[0].LiveTemp_oC`.
 */
export function splitPath(path: string): Array<string | number> {
  const out: Array<string | number> = []
  for (const part of path.split('.')) {
    const match = /^([^[]+)((?:\[\d+\])*)$/.exec(part)
    if (!match) {
      out.push(part)
      continue
    }
    out.push(match[1])
    for (const idx of match[2].matchAll(/\[(\d+)\]/g))
      out.push(Number(idx[1]))
  }
  return out
}

/** Segment names that would walk onto (or reassign) the prototype chain. Never traversable. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function step(node: unknown, key: string | number): unknown {
  if (node === null || typeof node !== 'object')
    return undefined
  if (typeof key === 'string' && UNSAFE_KEYS.has(key))
    return undefined
  return (node as Indexable)[key as never]
}

/**
 * Normalize a concrete delta path for allowlist lookup: bracket indices collapse to `[]` so
 * `RemoteZoneInfo[3].LiveTemp_oC` and `RemoteZoneInfo[0].LiveTemp_oC` match the same
 * allowlist entry in schemas.ts without enumerating every index.
 */
export function normalizeDeltaPath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]')
}

export function getPath<T = unknown>(tree: object, path: string): T | undefined {
  let node: unknown = tree
  for (const key of splitPath(path)) {
    node = step(node, key)
    if (node === undefined)
      return undefined
  }
  return node as T
}

/**
 * Write `value` at `path`. Returns false if an intermediate segment is missing — the
 * caller treats that as "resync from REST" rather than inventing structure.
 */
export function setPath(tree: object, path: string, value: unknown): boolean {
  const keys = splitPath(path)
  const last = keys.pop()
  if (last === undefined)
    return false

  let node: unknown = tree
  for (const key of keys) {
    node = step(node, key)
    if (node === null || typeof node !== 'object')
      return false
  }

  if (node === null || typeof node !== 'object')
    return false
  if (typeof last === 'string' && UNSAFE_KEYS.has(last))
    return false
  if (Array.isArray(node) && typeof last === 'number' && last >= node.length)
    return false
  if (!Array.isArray(node) && typeof last === 'string' && !Object.hasOwn(node, last)) {
    return false
  }

  const indexable = node as Indexable
  indexable[last as never] = value as never
  return true
}

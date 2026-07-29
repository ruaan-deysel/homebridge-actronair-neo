import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'

function tree() {
  return StatusResponseSchema.parse(JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))).lastKnownState
}

describe('neoState', () => {
  it('starts empty and reports not ready', () => {
    expect(new NeoState().ready).toBe(false)
  })

  it('becomes ready after replace and exposes values by path', () => {
    const s = new NeoState()
    s.replace(tree())
    expect(s.ready).toBe(true)
    expect(s.get('UserAirconSettings.Mode')).toBeTypeOf('string')
  })

  it('applies a dotted delta and notifies listeners with changed paths', () => {
    const s = new NeoState()
    s.replace(tree())
    const seen: Array<Set<string>> = []
    s.onChange(paths => seen.push(paths))

    const applied = s.applyDelta({
      'type': 'status-change-broadcast',
      'UserAirconSettings.TemperatureSetpoint_Cool_oC': 24,
    })

    expect(applied.ok).toBe(true)
    expect(applied.rejected).toHaveLength(0)
    expect(s.get('UserAirconSettings.TemperatureSetpoint_Cool_oC')).toBe(24)
    expect(seen).toHaveLength(1)
    expect(seen[0].has('UserAirconSettings.TemperatureSetpoint_Cool_oC')).toBe(true)
  })

  it('ignores the type key and does not notify when nothing changed', () => {
    const s = new NeoState()
    s.replace(tree())
    const current = s.get<number>('UserAirconSettings.TemperatureSetpoint_Cool_oC')
    const listener = vi.fn()
    s.onChange(listener)

    s.applyDelta({ 'UserAirconSettings.TemperatureSetpoint_Cool_oC': current })
    expect(listener).not.toHaveBeenCalled()
  })

  // Fix round 1: live broker capture shows real status-change broadcasts routinely bundle
  // fields this plugin doesn't consume (damper position, outdoor room temp, ...) alongside
  // ones it does, in the SAME message. An unknown path is normal cloud traffic, not a
  // malformed message — it must be skipped and reported separately, not treated as a reason
  // to reject the whole delta (that was round 0's bug: it made MQTT reject nearly every
  // broadcast and resync from REST on almost every message).
  it('ignores an unrecognized path without rejecting the delta or triggering a resync signal', () => {
    const s = new NeoState()
    s.replace(tree())
    const result = s.applyDelta({ 'NoSuchSection.Whatever': 1 })
    expect(result.ok).toBe(true)
    expect(result.rejected).toHaveLength(0)
    expect(result.ignored).toEqual(['NoSuchSection.Whatever'])
  })

  it('applies a verbatim captured broadcast: writes the known field, ignores the unknown ones', () => {
    const s = new NeoState()
    s.replace(tree())
    const seen: Array<Set<string>> = []
    s.onChange(paths => seen.push(paths))

    // Captured from the live broker after toggling a zone.
    const result = s.applyDelta({
      'type': 'status-change-broadcast',
      'RemoteZoneInfo[1].ZonePosition': 5, // damper position — not read anywhere
      'LiveAircon.OutdoorUnit.RoomTemp': 23.8, // not read anywhere
      'MasterInfo.LiveHumidity_pc': 53.8, // read by master.ts / outdoorTemp.ts's WATCHED table
    })

    expect(result.ok).toBe(true)
    expect(result.rejected).toHaveLength(0)
    expect(result.ignored.sort()).toEqual(['LiveAircon.OutdoorUnit.RoomTemp', 'RemoteZoneInfo[1].ZonePosition'])
    expect(s.get('MasterInfo.LiveHumidity_pc')).toBe(53.8)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(new Set(['MasterInfo.LiveHumidity_pc']))
  })

  it('a delta of only unknown paths is a no-op: ok true, nothing written, no notification', () => {
    const s = new NeoState()
    s.replace(tree())
    const listener = vi.fn()
    s.onChange(listener)

    const result = s.applyDelta({
      'RemoteZoneInfo[1].ZonePosition': 5,
      'LiveAircon.OutdoorUnit.RoomTemp': 23.8,
    })

    expect(result.ok).toBe(true)
    expect(result.rejected).toHaveLength(0)
    expect(result.ignored).toHaveLength(2)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects a wrong-typed value on a known path instead of storing it', () => {
    const s = new NeoState()
    s.replace(tree())
    const result = s.applyDelta({ 'UserAirconSettings.isOn': 'true' })
    expect(result.ok).toBe(false)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].path).toBe('UserAirconSettings.isOn')
    // Unchanged: booleans are never coerced from strings (unlike the documented numeric
    // coercions), so the original value survives.
    expect(s.get('UserAirconSettings.isOn')).not.toBe('true')
  })

  it('applies bracket-index zone deltas', () => {
    const s = new NeoState()
    s.replace(tree())
    expect(s.applyDelta({ 'RemoteZoneInfo[0].TemperatureSetpoint_Cool_oC': 19 }).ok).toBe(true)
    expect(s.get('RemoteZoneInfo[0].TemperatureSetpoint_Cool_oC')).toBe(19)
  })

  // Contract: a KNOWN path with a bad value still rejects the whole delta atomically — this
  // is the case atomicity exists for, distinct from the "unknown path" case above. A partial
  // apply here could leave correlated HVAC fields inconsistent (mode from one snapshot,
  // setpoints from another).
  it('leaves the tree completely unchanged when a known path in the delta has an invalid value', () => {
    const s = new NeoState()
    s.replace(tree())
    const originalMode = s.get('UserAirconSettings.Mode')
    const seen: Array<Set<string>> = []
    s.onChange(paths => seen.push(paths))

    const applied = s.applyDelta({
      'UserAirconSettings.Mode': 'COOL',
      'UserAirconSettings.isOn': 'not-a-boolean',
    })

    expect(applied.ok).toBe(false)
    expect(applied.rejected.map(r => r.path)).toEqual(['UserAirconSettings.isOn'])
    expect(s.get('UserAirconSettings.Mode')).toBe(originalMode)
    expect(seen).toHaveLength(0)
  })

  // Regression guard: an unknown-looking prototype-pollution path is rejected by the
  // allowlist itself (it was never a path this plugin reads), so it never even reaches
  // setPath's UNSAFE_KEYS guard — belt and suspenders.
  it('treats a prototype-pollution path as unrecognized, never writes it', () => {
    const s = new NeoState()
    s.replace(tree())
    const result = s.applyDelta({ '__proto__.polluted': 'PWNED' })
    expect(result.ok).toBe(true)
    expect(result.ignored).toEqual(['__proto__.polluted'])
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does not notify when a delta sets an array to a deep-equal array', () => {
    const s = new NeoState()
    s.replace(tree())
    const current = s.get<boolean[]>('UserAirconSettings.EnabledZones')
    const listener = vi.fn()
    s.onChange(listener)

    const applied = s.applyDelta({ 'UserAirconSettings.EnabledZones': [...current!] })
    expect(applied.ok).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies when a delta sets an array to a genuinely different array', () => {
    const s = new NeoState()
    s.replace(tree())
    const current = s.get<boolean[]>('UserAirconSettings.EnabledZones')
    const changedArray = current!.map(v => !v)
    const seen: Array<Set<string>> = []
    s.onChange(paths => seen.push(paths))

    const applied = s.applyDelta({ 'UserAirconSettings.EnabledZones': changedArray })
    expect(applied.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].has('UserAirconSettings.EnabledZones')).toBe(true)
  })

  it('notifies remaining listeners even when one listener throws', () => {
    const s = new NeoState()
    s.replace(tree())
    const goodListener = vi.fn()
    s.onChange(() => {
      throw new Error('boom')
    })
    s.onChange(goodListener)

    s.applyDelta({ 'UserAirconSettings.Mode': 'COOL' })
    expect(goodListener).toHaveBeenCalledTimes(1)
  })

  it('reports changed sections on replace', () => {
    const s = new NeoState()
    s.replace(tree())
    const seen: Array<Set<string>> = []
    s.onChange(p => seen.push(p))

    const next = tree()
    next.UserAirconSettings.Mode = 'COOL'
    s.replace(next)

    expect(seen[0].has('UserAirconSettings.Mode')).toBe(true)
  })
})

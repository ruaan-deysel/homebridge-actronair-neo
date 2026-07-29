import { describe, expect, it } from 'vitest'
import { getPath, normalizeDeltaPath, setPath } from '../src/neo/paths.js'

describe('path helpers', () => {
  const tree = () => ({
    UserAirconSettings: { Mode: 'HEAT', EnabledZones: [true, false] },
    RemoteZoneInfo: [{ LiveTemp_oC: 21 }, { LiveTemp_oC: 22 }],
  })

  it('reads a dotted path', () => {
    expect(getPath(tree(), 'UserAirconSettings.Mode')).toBe('HEAT')
  })

  it('reads a bracket-index path', () => {
    expect(getPath(tree(), 'RemoteZoneInfo[1].LiveTemp_oC')).toBe(22)
  })

  it('reads an array element', () => {
    expect(getPath(tree(), 'UserAirconSettings.EnabledZones[0]')).toBe(true)
  })

  it('writes a dotted path', () => {
    const t = tree()
    expect(setPath(t, 'UserAirconSettings.Mode', 'COOL')).toBe(true)
    expect(t.UserAirconSettings.Mode).toBe('COOL')
  })

  it('writes a bracket-index path', () => {
    const t = tree()
    expect(setPath(t, 'RemoteZoneInfo[0].LiveTemp_oC', 25)).toBe(true)
    expect(t.RemoteZoneInfo[0].LiveTemp_oC).toBe(25)
  })

  it('refuses to write through a missing intermediate', () => {
    const t = tree()
    expect(setPath(t, 'NoSuchSection.Field', 1)).toBe(false)
  })

  it('refuses to write a final key that only exists on the prototype chain, not as its own property', () => {
    const t = tree()
    expect(setPath(t, 'UserAirconSettings.toString', 'nope')).toBe(false)
    expect(setPath(t, 'UserAirconSettings.hasOwnProperty', 'nope')).toBe(false)
    // A genuinely missing own key still refuses too (unchanged behaviour).
    expect(setPath(t, 'UserAirconSettings.NoSuchField', 1)).toBe(false)
  })

  it('refuses to traverse through __proto__, even onto a real own property of Object.prototype', () => {
    const t = tree()
    expect(setPath(t, 'UserAirconSettings.__proto__.toString', 'PWNED')).toBe(false)
    expect(Object.prototype.toString).not.toBe('PWNED')
  })

  it('refuses to traverse through constructor.prototype', () => {
    const t = tree()
    expect(setPath(t, 'UserAirconSettings.constructor.prototype.polluted', 'PWNED')).toBe(false)
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses __proto__/constructor/prototype as the final segment too', () => {
    const t = tree()
    expect(setPath(t, '__proto__', 'PWNED')).toBe(false)
    expect(setPath(t, 'constructor', 'PWNED')).toBe(false)
    expect(setPath(t, 'prototype', 'PWNED')).toBe(false)
  })

  it('does not throw on malformed paths', () => {
    expect(() => getPath(tree(), '[0]')).not.toThrow()
    expect(() => getPath(tree(), 'UserAirconSettings.')).not.toThrow()
    expect(() => getPath(tree(), '.Mode')).not.toThrow()
  })

  it('normalizes bracket indices for allowlist lookup', () => {
    expect(normalizeDeltaPath('RemoteZoneInfo[0].LiveTemp_oC')).toBe('RemoteZoneInfo[].LiveTemp_oC')
    expect(normalizeDeltaPath('RemoteZoneInfo[7].LiveTemp_oC')).toBe('RemoteZoneInfo[].LiveTemp_oC')
    expect(normalizeDeltaPath('AirconSystem.Peripherals[2].RSSI.Local')).toBe('AirconSystem.Peripherals[].RSSI.Local')
    expect(normalizeDeltaPath('UserAirconSettings.Mode')).toBe('UserAirconSettings.Mode')
  })
})

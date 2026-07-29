import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'

describe('parseConfig', () => {
  it('applies defaults when only required fields are present', () => {
    const cfg = parseConfig({ platform: 'ActronAirNeo', name: 'ActronAir Neo' })
    expect(cfg.refreshIntervalMs).toBe(60_000)
    expect(cfg.zonesAsHeaterCoolers).toBe(false)
    expect(cfg.clientId).toBe('home_assistant')
    expect(cfg.debug).toBe(false)
  })

  it('converts refreshInterval seconds to milliseconds', () => {
    const cfg = parseConfig({ platform: 'ActronAirNeo', name: 'x', refreshInterval: 30 })
    expect(cfg.refreshIntervalMs).toBe(30_000)
  })

  it('rejects a non-numeric refreshInterval', () => {
    expect(() => parseConfig({ platform: 'ActronAirNeo', name: 'x', refreshInterval: 'soon' }))
      .toThrow(/refreshInterval/)
  })

  it('ignores options that no longer exist, so an existing config.json still starts', () => {
    // These were removed for parity with the reference HA integration. A user's config still
    // carrying them must be a silent no-op, never a validation failure at startup.
    const cfg = parseConfig({
      platform: 'ActronAirNeo',
      name: 'x',
      pushEnabled: false,
      commandDebounceMs: 250,
      setpointDebounceMs: 2000,
      zonesPushMaster: false,
      maxCoolingTemp: 30,
      minCoolingTemp: 18,
      maxHeatingTemp: 24,
      minHeatingTemp: 12,
    })

    expect(cfg.name).toBe('x')
    expect(cfg.refreshIntervalMs).toBe(60_000)
    for (const removed of ['pushEnabled', 'commandDebounceMs', 'setpointDebounceMs', 'zonesPushMaster', 'maxCoolingTemp', 'minCoolingTemp', 'maxHeatingTemp', 'minHeatingTemp'])
      expect(Object.hasOwn(cfg, removed)).toBe(true) // passed through untouched by looseObject, never read
  })

  it('carries the refresh token through when present', () => {
    const cfg = parseConfig({ platform: 'ActronAirNeo', name: 'x', refreshToken: 'abc' })
    expect(cfg.refreshToken).toBe('abc')
  })
})

describe('config.schema.json form visibility', () => {
  // Homebridge's settings form rebuilds the platform config from schema-declared properties and
  // DISCARDS anything undeclared. Deleting these to hide them wipes the user's account link on the
  // next Save — verified live against a real Homebridge 2.2.1. They must stay declared, and stay
  // hidden via `condition`, which round-trips the value untouched.
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'))
  const props = schema.schema.properties

  it.each(['refreshToken', 'deviceSerial', 'clientId'])(
    'declares %s so a schema-form save cannot drop it, but never renders it',
    (key) => {
      expect(props[key]).toBeDefined()
      expect(props[key].condition?.functionBody).toBe('return false;')
    },
  )

  it('renders only the options a user should touch', () => {
    const visible = Object.entries(props)
      .filter(([, v]) => (v as { condition?: unknown }).condition === undefined)
      .map(([k]) => k)
    expect(visible).toEqual(['name', 'zonesAsHeaterCoolers', 'refreshInterval', 'debug'])
  })
})

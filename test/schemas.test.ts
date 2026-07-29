import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getPath, setPath } from '../src/neo/paths.js'
import {
  AcSystemsSchema,
  CommandResponseSchema,
  ConnectionDetailsSchema,
  DeviceCodeSchema,
  FullStatusPushSchema,
  StatusChangeSchema,
  StatusResponseSchema,
  TokenSchema,
  validateDeltaValue,
} from '../src/neo/schemas.js'

const fixture = (n: string) => JSON.parse(readFileSync(`test/fixtures/${n}.json`, 'utf8'))

describe('neo schemas', () => {
  it('parses a REST status response', () => {
    const parsed = StatusResponseSchema.parse(fixture('rest-status'))
    expect(parsed.isOnline).toBe(true)
    expect(parsed.lastKnownState.UserAirconSettings.Mode).toBeTypeOf('string')
    expect(Array.isArray(parsed.lastKnownState.RemoteZoneInfo)).toBe(true)
  })

  it('unwraps the MQTT full-status envelope', () => {
    const parsed = FullStatusPushSchema.parse(fixture('full-status'))
    expect(parsed.event.UserAirconSettings).toBeDefined()
  })

  it('parses a status-change delta as flat dotted keys', () => {
    const parsed = StatusChangeSchema.parse(fixture('status-change'))
    expect(parsed.event['UserAirconSettings.TemperatureSetpoint_Cool_oC']).toBe(22.5)
    expect(parsed.event.type).toBe('status-change-broadcast')
  })

  it('coerces NV_Limits.UserSetpoint_oC fields from string to number', () => {
    const raw = fixture('rest-status')
    raw.lastKnownState.NV_Limits.UserSetpoint_oC.setCool_Max = '30'
    raw.lastKnownState.NV_Limits.UserSetpoint_oC.VarianceAboveMasterCool = '2'

    const parsed = StatusResponseSchema.parse(raw)
    const limits = parsed.lastKnownState.NV_Limits!.UserSetpoint_oC!
    expect(limits.setCool_Max).toBe(30)
    expect(limits.VarianceAboveMasterCool).toBe(2)
  })

  it('parses a status response with NV_Limits entirely absent', () => {
    const raw = fixture('rest-status')
    delete raw.lastKnownState.NV_Limits

    const parsed = StatusResponseSchema.parse(raw)
    expect(parsed.lastKnownState.NV_Limits).toBeUndefined()
  })

  it('coerces connection detail Port from string to number', () => {
    const parsed = ConnectionDetailsSchema.parse(fixture('connection-details'))
    expect(parsed.Port).toBe(8883)
    expect(parsed.Endpoint).toBe('203.0.113.10')
  })

  it('parses the systems list', () => {
    const parsed = AcSystemsSchema.parse(fixture('ac-systems'))
    expect(parsed._embedded['ac-system'][0].serial).toBe('neo000000')
  })

  it('tolerates unknown extra fields', () => {
    const raw = fixture('connection-details')
    raw.SomeNewFieldActronAdded = 'whatever'
    expect(() => ConnectionDetailsSchema.parse(raw)).not.toThrow()
  })

  it('fails with a path when a consumed field is missing', () => {
    const raw = fixture('rest-status')
    delete raw.lastKnownState.UserAirconSettings
    expect(() => StatusResponseSchema.parse(raw)).toThrow(/UserAirconSettings/)
  })

  it('parses a device code response', () => {
    expect(DeviceCodeSchema.parse({
      device_code: 'd',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://x/connect',
      verification_uri_complete: 'https://x/connect?userCode=ABCD-EFGH',
      interval: 5,
      expires_in: 1800,
    }).user_code).toBe('ABCD-EFGH')
  })

  it('parses a token response without a refresh token', () => {
    const t = TokenSchema.parse({ access_token: 'a', token_type: 'bearer', expires_in: 259199 })
    expect(t.refresh_token).toBeUndefined()
  })

  it('recognises a command ack', () => {
    expect(CommandResponseSchema.parse({ type: 'ack', correlationId: 'x', value: {} }).type).toBe('ack')
  })

  it('parses AirconSystem model/capability identity fields (owner\'s real fixture)', () => {
    const parsed = StatusResponseSchema.parse(fixture('rest-status'))
    const system = parsed.lastKnownState.AirconSystem
    expect(system.MasterWCModel).toBe('NTW-1000')
    expect(system.IndoorUnit?.NV_ModelNumber).toBe('EVA150S')
    expect(system.IndoorUnit?.NV_SupportedFanModes).toBe(3)
    expect(system.IndoorUnit?.NV_AutoFanEnabled).toBe(false)
    expect(system.OutdoorUnit?.Family).toBe('Fixed Speed: Classic')
    expect(system.OutdoorUnit?.Capacity_kW).toBe(15)
  })

  it('defaults AirconSystem to an empty object when entirely absent', () => {
    const raw = fixture('rest-status')
    delete raw.lastKnownState.AirconSystem
    const parsed = StatusResponseSchema.parse(raw)
    expect(parsed.lastKnownState.AirconSystem).toEqual({})
  })

  it('coerces AirconSystem numeric fields from string to number', () => {
    const raw = fixture('rest-status')
    raw.lastKnownState.AirconSystem.IndoorUnit.NV_SupportedFanModes = '7'
    raw.lastKnownState.AirconSystem.OutdoorUnit.Capacity_kW = '18'
    const parsed = StatusResponseSchema.parse(raw)
    expect(parsed.lastKnownState.AirconSystem.IndoorUnit?.NV_SupportedFanModes).toBe(7)
    expect(parsed.lastKnownState.AirconSystem.OutdoorUnit?.Capacity_kW).toBe(18)
  })
})

/**
 * The cloud uses "NA" for an absent numeric — the real fixture contains 64 of them, four at
 * AirconSystem.Peripherals[N].RSSI.Remote, the immediate sibling of the coerced RSSI.Local.
 * z.coerce.number() cannot parse "NA", so one of these on a coerced field would fail the
 * WHOLE status parse (freezing every accessory on stale state), while null/"" silently
 * coerced to 0.
 */
describe('absent-numeric sentinels on coerced fields', () => {
  const COERCED_PATHS = [
    // The live-reading fields, most likely to go absent when a sensor drops out.
    'RemoteZoneInfo[0].LiveTemp_oC',
    'RemoteZoneInfo[0].LiveHumidity_pc',
    'RemoteZoneInfo[0].TemperatureSetpoint_Cool_oC',
    'MasterInfo.LiveTemp_oC',
    'MasterInfo.LiveHumidity_pc',
    'UserAirconSettings.TemperatureSetpoint_Cool_oC',
    'AirconSystem.Peripherals[0].RemainingBatteryCapacity_pc',
    'AirconSystem.Peripherals[0].RSSI.Local',
    'AirconSystem.IndoorUnit.NV_SupportedFanModes',
    'AirconSystem.OutdoorUnit.Capacity_kW',
    'MasterInfo.LiveOutdoorTemp_oC',
    'NV_Limits.UserSetpoint_oC.setCool_Max',
    'UserAirconSettings.AfterHours.Duration',
  ]

  for (const path of COERCED_PATHS) {
    for (const sentinel of ['NA', null, '']) {
      it(`treats ${JSON.stringify(sentinel)} at ${path} as absent, without failing the status parse`, () => {
        const raw = fixture('rest-status')
        expect(setPath(raw.lastKnownState, path, sentinel)).toBe(true)

        const parsed = StatusResponseSchema.parse(raw)

        expect(getPath(parsed.lastKnownState, path)).toBeUndefined()
      })
    }
  }

  it('treats a sentinel on an optional field the fixture omits as absent too (MinCoolSetpoint)', () => {
    const raw = fixture('rest-status')
    raw.lastKnownState.RemoteZoneInfo[0].MinCoolSetpoint = 'NA'
    const parsed = StatusResponseSchema.parse(raw)
    expect(parsed.lastKnownState.RemoteZoneInfo[0].MinCoolSetpoint).toBeUndefined()
  })

  it('still coerces genuine string digits (the documented behaviour these sentinels sit alongside)', () => {
    const raw = fixture('rest-status')
    setPath(raw.lastKnownState, 'MasterInfo.LiveOutdoorTemp_oC', '21.5')
    expect(StatusResponseSchema.parse(raw).lastKnownState.MasterInfo.LiveOutdoorTemp_oC).toBe(21.5)
  })

  it('accepts the same sentinels on a status-change delta rather than rejecting the whole delta', () => {
    expect(validateDeltaValue('AirconSystem.Peripherals[0].RSSI.Local', 'NA')).toEqual({ ok: true, value: undefined })
    expect(validateDeltaValue('RemoteZoneInfo[2].LiveTemp_oC', 'NA')).toEqual({ ok: true, value: undefined })
    expect(validateDeltaValue('MasterInfo.LiveOutdoorTemp_oC', '19')).toEqual({ ok: true, value: 19 })
  })
})

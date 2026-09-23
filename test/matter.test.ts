import type { CommandQueue } from '../src/neo/commands.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildMatterAccessory } from '../src/matter/mapping.js'
import { buildMasterMatterAccessory } from '../src/matter/master.js'
import { buildOutdoorTempMatterAccessory } from '../src/matter/sensors.js'
import { buildSwitchMatterAccessory } from '../src/matter/switches.js'
import { buildAfterHoursMatterAccessory } from '../src/matter/valve.js'
import { buildZoneMatterAccessory } from '../src/matter/zone.js'
import { NeoState } from '../src/neo/state.js'
import { CommandResult, NeoCommand } from '../src/neo/types.js'

const restStatus = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))

function makePlatform(cfgOverrides: Record<string, unknown> = {}) {
  const state = new NeoState()
  state.setCloudConnected(true)
  state.replace(JSON.parse(JSON.stringify(restStatus.lastKnownState)))

  const updateAccessoryState = vi.fn().mockResolvedValue(undefined)
  const registerPlatformAccessories = vi.fn().mockResolvedValue(undefined)
  const unregisterPlatformAccessories = vi.fn().mockResolvedValue(undefined)
  const updatePlatformAccessories = vi.fn().mockResolvedValue(undefined)

  const matterApi = {
    uuid: {
      generate: vi.fn((s: string) => `matter-uuid-${s}`),
    },
    deviceTypes: {
      Thermostat: { name: 'Thermostat' },
      Fan: { name: 'Fan' },
      HumiditySensor: { name: 'HumiditySensor' },
      TemperatureSensor: { name: 'TemperatureSensor' },
      OnOffSwitch: { name: 'OnOffSwitch' },
      WaterValve: { name: 'WaterValve' },
    },
    updateAccessoryState,
    registerPlatformAccessories,
    unregisterPlatformAccessories,
    updatePlatformAccessories,
  }

  const log = Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })

  const commands = {
    run: vi.fn().mockResolvedValue(CommandResult.SUCCESS),
    syncEnabledZones: vi.fn(),
  } as unknown as CommandQueue

  const platform = {
    api: {
      matter: matterApi,
      hap: {
        Service: {},
        Characteristic: {},
        uuid: { generate: (s: string) => `uuid-${s}` },
      },
      isMatterAvailable: () => true,
      isMatterEnabled: () => true,
    },
    log,
    state,
    commands,
    serial: 'NEO123456',
    capabilities: {
      model: 'ActronAir Neo Test Model',
      modes: { auto: true, heat: true, cool: true, fan: true },
      fanSpeeds: ['LOW', 'MED', 'HIGH', 'AUTO'],
      supportsTurbo: true,
      supportsVft: false,
      quietModeAvailable: true,
      outdoorTempUsable: true,
    },
    cfg: {
      name: 'Test AC',
      zonesAsHeaterCoolers: true,
      ...cfgOverrides,
    },
  }

  return { platform: platform as never, matterApi, commands: commands as unknown as { run: ReturnType<typeof vi.fn> } }
}

describe('matter layer', () => {
  describe('master thermostat', () => {
    it('creates a Thermostat accessory with fan and humidity parts', () => {
      const { platform } = makePlatform()
      const { accessory, binding } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      expect(accessory.UUID).toBe('matter-uuid-matter:NEO123456')
      expect(accessory.displayName).toBe('Air Conditioner')
      expect(accessory.deviceType).toEqual({ name: 'Thermostat' })
      expect(accessory.clusters?.thermostat).toBeDefined()
      expect(accessory.clusters?.thermostat?.minSetpointDeadBand).toBe(20)
      expect(accessory.clusters?.thermostat?.occupiedHeatingSetpoint).toBe(2200)
      expect(accessory.clusters?.thermostat?.occupiedCoolingSetpoint).toBe(2200)

      expect(accessory.parts).toHaveLength(2)
      expect(accessory.parts?.[0].id).toBe('fan')
      expect(accessory.parts?.[0].deviceType).toEqual({ name: 'Fan' })
      expect(accessory.parts?.[1].id).toBe('humidity')
      expect(accessory.parts?.[1].deviceType).toEqual({ name: 'HumiditySensor' })

      expect(binding.uuid).toBe(accessory.UUID)
    })

    it('handles systemModeChange commands', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      const thermostatHandlers = accessory.handlers?.thermostat
      expect(thermostatHandlers).toBeDefined()

      // Turn Off (0)
      await thermostatHandlers!.systemModeChange!({ systemMode: 0 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.OFF)

      // Turn Auto (1)
      await thermostatHandlers!.systemModeChange!({ systemMode: 1 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.CLIMATE_MODE_AUTO)

      // Turn Cool (3)
      await thermostatHandlers!.systemModeChange!({ systemMode: 3 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.CLIMATE_MODE_COOL)

      // Turn Heat (4)
      await thermostatHandlers!.systemModeChange!({ systemMode: 4 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.CLIMATE_MODE_HEAT)

      // Turn FanOnly (7)
      await thermostatHandlers!.systemModeChange!({ systemMode: 7 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_ONLY_ON)
    })

    it('turns system on first when switching mode while off', async () => {
      const { platform, commands } = makePlatform()
      platform.state.applyDelta({ 'UserAirconSettings.isOn': false })
      const { accessory } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      const handlers = accessory.handlers!.thermostat!
      await handlers.systemModeChange!({ systemMode: 3 /* Cool */ })
      expect(commands.run).toHaveBeenNthCalledWith(1, NeoCommand.ON)
      expect(commands.run).toHaveBeenNthCalledWith(2, NeoCommand.CLIMATE_MODE_COOL)
    })

    it('fails system mode changes if power-on command fails while off', async () => {
      const { platform, commands } = makePlatform()
      platform.state.applyDelta({ 'UserAirconSettings.isOn': false })
      commands.run.mockResolvedValueOnce(CommandResult.FAILURE)

      const { accessory } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      await expect(accessory.handlers!.thermostat!.systemModeChange!({ systemMode: 3 })).rejects.toThrow('Command failed to apply')
      expect(commands.run).toHaveBeenCalledTimes(1)
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.ON)
    })

    it('handles heating and cooling setpoint changes', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      const handlers = accessory.handlers!.thermostat!

      await handlers.occupiedHeatingSetpointChange!({ occupiedHeatingSetpoint: 2150 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.HEAT_SET_POINT, { heatTemp: 21.5 })

      await handlers.occupiedCoolingSetpointChange!({ occupiedCoolingSetpoint: 2350 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, { coolTemp: 23.5 })
    })

    it('handles fan mode and percent changes', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      const fanPart = accessory.parts?.find(p => p.id === 'fan')
      expect(fanPart?.handlers?.fanControl).toBeDefined()
      const handlers = fanPart!.handlers!.fanControl!

      // Fan modes
      await handlers.fanModeChange!({ fanMode: 1 /* Low */ })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_LOW)

      await handlers.fanModeChange!({ fanMode: 2 /* Medium */ })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_MEDIUM)

      await handlers.fanModeChange!({ fanMode: 3 /* High */ })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_HIGH)

      await handlers.fanModeChange!({ fanMode: 5 /* Auto */ })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_AUTO)

      await handlers.fanModeChange!({ fanMode: 0 /* Off */ })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.OFF)

      // Percent settings
      await handlers.percentSettingChange!({ percentSetting: 25 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_LOW)

      await handlers.percentSettingChange!({ percentSetting: 50 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_MEDIUM)

      await handlers.percentSettingChange!({ percentSetting: 90 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_HIGH)

      await handlers.percentSettingChange!({ percentSetting: 0 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.OFF)

      await handlers.percentSettingChange!({ percentSetting: null })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_AUTO)
    })

    it('syncs state updates via binding.update', async () => {
      const { platform, matterApi } = makePlatform()
      const { binding } = buildMasterMatterAccessory(platform, {
        id: 'NEO123456',
        displayName: 'Air Conditioner',
        kind: 'master',
      })

      binding.update(new Set(['UserAirconSettings.Mode', 'UserAirconSettings.TemperatureSetpoint_Cool_oC']))

      expect(matterApi.updateAccessoryState).toHaveBeenCalledWith(
        binding.uuid,
        'thermostat',
        expect.objectContaining({
          systemMode: expect.any(Number),
          occupiedCoolingSetpoint: 2200,
        }),
      )
    })
  })

  describe('zone accessory', () => {
    it('creates a Thermostat when zonesAsHeaterCoolers is true', () => {
      const { platform } = makePlatform({ zonesAsHeaterCoolers: true })
      const { accessory, binding } = buildZoneMatterAccessory(platform, {
        id: 'zone-0',
        displayName: 'Living Room',
        kind: 'zone',
        zoneIndex: 0,
      })

      expect(accessory.UUID).toBe('matter-uuid-matter:zone-0')
      expect(accessory.deviceType).toEqual({ name: 'Thermostat' })
      expect(accessory.clusters?.thermostat).toBeDefined()
      expect(accessory.handlers?.thermostat).toBeDefined()
      expect(binding.uuid).toBe(accessory.UUID)
    })

    it('handles zone systemModeChange as zone enable/disable', async () => {
      const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: true })
      const { accessory } = buildZoneMatterAccessory(platform, {
        id: 'zone-0',
        displayName: 'Living Room',
        kind: 'zone',
        zoneIndex: 0,
      })

      const handlers = accessory.handlers!.thermostat!

      // Turn Off
      await handlers.systemModeChange!({ systemMode: 0 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_DISABLE, { zoneIndex: 0 })

      // Turn On (e.g. Auto = 1)
      await handlers.systemModeChange!({ systemMode: 1 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_ENABLE, { zoneIndex: 0 })
    })

    it('creates an OnOffSwitch when zonesAsHeaterCoolers is false', async () => {
      const { platform, commands, matterApi } = makePlatform({ zonesAsHeaterCoolers: false })
      const { accessory, binding } = buildZoneMatterAccessory(platform, {
        id: 'zone-0',
        displayName: 'Living Room',
        kind: 'zone',
        zoneIndex: 0,
      })

      expect(accessory.UUID).toBe('matter-uuid-matter:zone-0')
      expect(accessory.deviceType).toEqual({ name: 'OnOffSwitch' })
      expect(accessory.clusters?.onOff).toBeDefined()
      expect(accessory.handlers?.onOff).toBeDefined()

      // Should have temperature and humidity parts
      expect(accessory.parts?.some(p => p.id === 'temperature')).toBe(true)
      expect(accessory.parts?.some(p => p.id === 'humidity')).toBe(true)

      // Test switch handlers
      await accessory.handlers!.onOff!.on!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_ENABLE, { zoneIndex: 0 })

      await accessory.handlers!.onOff!.off!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_DISABLE, { zoneIndex: 0 })

      // Test state sync
      matterApi.updateAccessoryState.mockClear()
      binding.update(new Set(['UserAirconSettings.EnabledZones']))
      expect(matterApi.updateAccessoryState).toHaveBeenCalledWith(
        binding.uuid,
        'onOff',
        expect.objectContaining({ onOff: expect.any(Boolean) }),
      )
    })
  })

  describe('switches (away, quiet, continuousFan, turbo)', () => {
    it('creates away mode switch and toggles on/off', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildSwitchMatterAccessory(platform, {
        id: 'neo-away-mode',
        displayName: 'Away Mode',
        kind: 'away',
      }, 'away')

      expect(accessory.deviceType).toEqual({ name: 'OnOffSwitch' })
      expect(accessory.clusters?.onOff).toBeDefined()

      await accessory.handlers!.onOff!.on!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.AWAY_MODE_ON)

      await accessory.handlers!.onOff!.off!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.AWAY_MODE_OFF)
    })

    it('creates quiet mode switch and toggles on/off', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildSwitchMatterAccessory(platform, {
        id: 'neo-quiet-mode',
        displayName: 'Quiet Mode',
        kind: 'quiet',
      }, 'quiet')

      await accessory.handlers!.onOff!.on!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.QUIET_MODE_ON)

      await accessory.handlers!.onOff!.off!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.QUIET_MODE_OFF)
    })

    it('creates continuous fan switch preserving base fan speed', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildSwitchMatterAccessory(platform, {
        id: 'neo-continuous-fan-mode',
        displayName: 'Continuous Mode',
        kind: 'continuousFan',
      }, 'continuousFan')

      await accessory.handlers!.onOff!.on!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_HIGH_CONT)

      await accessory.handlers!.onOff!.off!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_HIGH)
    })

    it('creates turbo mode switch and toggles on/off', async () => {
      const { platform, commands } = makePlatform()
      const { accessory } = buildSwitchMatterAccessory(platform, {
        id: 'neo-turbo-mode',
        displayName: 'Turbo Mode',
        kind: 'turbo',
      }, 'turbo')

      await accessory.handlers!.onOff!.on!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.TURBO_MODE_ON)

      await accessory.handlers!.onOff!.off!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.TURBO_MODE_OFF)
    })
  })

  describe('sensors (outdoor temp)', () => {
    it('creates outdoor temperature sensor with centidegrees reading', () => {
      const { platform } = makePlatform()
      const { accessory, binding } = buildOutdoorTempMatterAccessory(platform, {
        id: 'neo-outdoor-temp',
        displayName: 'Outdoor Temperature',
        kind: 'outdoorTemp',
      })

      expect(accessory.deviceType).toEqual({ name: 'TemperatureSensor' })
      // Initial value is null because fixture has 3000 sentinel
      expect(accessory.clusters?.temperatureMeasurement?.measuredValue).toBeNull()

      // Update to valid reading without error
      platform.state.applyDelta({
        'MasterInfo.LiveOutdoorTemp_oC': 20,
        'LiveAircon.OutdoorUnit.AmbientSensErr': false,
      })
      binding.update(new Set(['MasterInfo.LiveOutdoorTemp_oC', 'LiveAircon.OutdoorUnit.AmbientSensErr']))
      expect(platform.api.matter?.updateAccessoryState).toHaveBeenCalledWith(
        binding.uuid,
        'temperatureMeasurement',
        { measuredValue: 2000 },
      )

      platform.state.applyDelta({
        'MasterInfo.LiveOutdoorTemp_oC': 3000,
        'LiveAircon.OutdoorUnit.AmbientSensErr': true,
      })
      binding.update(new Set(['MasterInfo.LiveOutdoorTemp_oC', 'LiveAircon.OutdoorUnit.AmbientSensErr']))
      expect(platform.api.matter?.updateAccessoryState).toHaveBeenLastCalledWith(
        binding.uuid,
        'temperatureMeasurement',
        { measuredValue: null },
      )
    })
  })

  describe('valve (after hours)', () => {
    it('creates After Hours valve and handles open/close with duration', async () => {
      const { platform, commands } = makePlatform()
      const { accessory, binding } = buildAfterHoursMatterAccessory(platform, {
        id: 'neo-after-hours-mode',
        displayName: 'After Hours',
        kind: 'afterHours',
      })

      expect(accessory.deviceType).toEqual({ name: 'WaterValve' })
      expect(accessory.clusters?.valveConfigurationAndControl?.defaultOpenDuration).toBe(7200)

      const handlers = accessory.handlers!.valveConfigurationAndControl!

      // Open with duration (60 minutes = 3600 seconds)
      await handlers.open!({ openDuration: 3600 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_DURATION, { duration: 60 })
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_ON)

      // Close
      await handlers.close!()
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_OFF)

      // State update
      binding.update(new Set(['UserAirconSettings.AfterHours.Enabled']))
      expect(platform.api.matter?.updateAccessoryState).toHaveBeenCalledWith(
        binding.uuid,
        'valveConfigurationAndControl',
        expect.objectContaining({
          currentState: expect.any(Number),
          targetState: expect.any(Number),
        }),
      )
    })
  })

  describe('mapping dispatcher', () => {
    it('dispatches every discovered device kind', () => {
      const { platform } = makePlatform()
      const kinds = [
        { id: 'master', displayName: 'AC', kind: 'master' as const },
        { id: 'zone-0', displayName: 'Zone 1', kind: 'zone' as const, zoneIndex: 0 },
        { id: 'away', displayName: 'Away', kind: 'away' as const },
        { id: 'quiet', displayName: 'Quiet', kind: 'quiet' as const },
        { id: 'cont', displayName: 'Cont', kind: 'continuousFan' as const },
        { id: 'turbo', displayName: 'Turbo', kind: 'turbo' as const },
        { id: 'outdoor', displayName: 'Outdoor', kind: 'outdoorTemp' as const },
        { id: 'after', displayName: 'After Hours', kind: 'afterHours' as const },
      ]

      for (const dev of kinds) {
        const result = buildMatterAccessory(platform, dev)
        expect(result.accessory).toBeDefined()
        expect(result.binding).toBeDefined()
      }

      expect(() => buildMatterAccessory(platform, { id: 'unknown', displayName: 'Unknown', kind: 'invalid' as never })).toThrow(
        'Unsupported Matter device kind: invalid',
      )
    })
  })
})

import type { NeoCapabilities } from '../src/neo/capabilities.js'
import { readFileSync } from 'node:fs'
import { HAPStatus } from 'homebridge'
import { describe, expect, it, vi } from 'vitest'
import { MasterAccessory } from '../src/accessories/master.js'
import { deriveCapabilities } from '../src/neo/capabilities.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'
import { FanMode, NeoCommand } from '../src/neo/types.js'

/** Minimal fakes for the slice of HAP the accessory touches — no real hap-nodejs needed. */
class FakeCharacteristic {
  value: unknown
  props: Record<string, unknown> = {}
  private getter?: () => unknown
  private setter?: (v: unknown) => unknown

  onGet(fn: () => unknown) {
    this.getter = fn
    return this
  }

  onSet(fn: (v: unknown) => unknown) {
    this.setter = fn
    return this
  }

  setProps(props: Record<string, unknown>) {
    Object.assign(this.props, props)
    return this
  }

  updateValue(value: unknown) {
    this.value = value
    return this
  }

  async invokeSet(v: unknown) {
    return this.setter?.(v)
  }

  invokeGet() {
    return this.getter?.()
  }
}

class FakeService {
  characteristics = new Map<unknown, FakeCharacteristic>()
  updates: Array<{ id: unknown, value: unknown }> = []
  declaredOptional: unknown[] = []

  addOptionalCharacteristic(id: unknown) {
    this.declaredOptional.push(id)
  }

  testCharacteristic(id: unknown) {
    return this.characteristics.has(id)
  }

  getCharacteristic(id: unknown) {
    let c = this.characteristics.get(id)
    if (!c) {
      c = new FakeCharacteristic()
      this.characteristics.set(id, c)
    }
    return c
  }

  setCharacteristic(id: unknown, value: unknown) {
    this.getCharacteristic(id).value = value
    return this
  }

  updateCharacteristic(id: unknown, value: unknown) {
    this.updates.push({ id, value })
    this.getCharacteristic(id).value = value
    return this
  }
}

const Characteristic = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  Name: 'Name',
  CurrentRelativeHumidity: 'CurrentRelativeHumidity',
  Active: { ACTIVE: 1, INACTIVE: 0 },
  CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
  TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
  CurrentTemperature: 'CurrentTemperature',
  HeatingThresholdTemperature: 'HeatingThresholdTemperature',
  CoolingThresholdTemperature: 'CoolingThresholdTemperature',
  RotationSpeed: 'RotationSpeed',
  ConfiguredName: 'ConfiguredName',
}

const ServiceTokens = {
  AccessoryInformation: 'AccessoryInformation',
  HeaterCooler: 'HeaterCooler',
  HumiditySensor: 'HumiditySensor',
  Fanv2: 'Fanv2',
}

function baseTree() {
  return {
    UserAirconSettings: {
      isOn: true,
      Mode: 'COOL',
      FanMode: 'LOW',
      TemperatureSetpoint_Cool_oC: 22,
      TemperatureSetpoint_Heat_oC: 18,
      EnabledZones: [],
    },
    MasterInfo: { LiveTemp_oC: 24, LiveHumidity_pc: 45 },
    LiveAircon: { CompressorMode: 'COOL', AmRunningFan: true },
    RemoteZoneInfo: [],
  }
}

/** Default test capabilities: the historical 4-speed unit (LOW/MED/HIGH/AUTO). */
function fullCapabilities(): NeoCapabilities {
  return {
    model: 'Test Unit',
    modes: { cool: true, heat: true, auto: true, fan: true, dry: false },
    fanSpeeds: [FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH, FanMode.AUTO],
    supportsAutoFan: true,
    supportsTurbo: false,
    supportsVft: false,
    quietModeAvailable: false,
    outdoorTempUsable: false,
  }
}

function makeHarness(
  cfgOverrides: Record<string, unknown> = {},
  { seed = true, capabilities = fullCapabilities(), limits, cachedServices = [], seedCached }: {
    seed?: boolean
    capabilities?: NeoCapabilities
    /** Device-reported NV_Limits.UserSetpoint_oC, as the owner's real hardware sends. */
    limits?: Record<string, number>
    /** Services already on the cached accessory before construction. */
    cachedServices?: string[]
    /** Applied to each cached service before construction — e.g. a name HAP already stored. */
    seedCached?: (service: FakeService) => void
  } = {},
) {
  const state = new NeoState()
  state.setCloudConnected(true)
  if (seed)
    state.replace({ ...baseTree(), ...(limits ? { NV_Limits: { UserSetpoint_oC: limits } } : {}) } as never)

  const commands = { run: vi.fn().mockResolvedValue('SUCCESS') }

  const services = new Map<string, FakeService>()
  services.set(ServiceTokens.AccessoryInformation, new FakeService())
  for (const token of cachedServices) {
    const cached = new FakeService()
    seedCached?.(cached)
    services.set(token, cached)
  }
  const removed: string[] = []
  const accessory = {
    displayName: 'Master',
    getService: (token: string) => services.get(token),
    addService: (token: string) => {
      const s = new FakeService()
      services.set(token, s)
      return s
    },
    removeService: (service: FakeService) => {
      for (const [token, candidate] of services) {
        if (candidate === service) {
          services.delete(token)
          removed.push(token)
        }
      }
    },
  }

  const platform = {
    state,
    commands,
    capabilities,
    cfg: { ...cfgOverrides },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { hap: { HapStatusError: class HapStatusError extends Error {
      constructor(public hapStatus: HAPStatus) { super(`HAP ${hapStatus}`) }
    } } },
    Service: ServiceTokens,
    Characteristic,
    serial: 'ABC123',
  }

  const master = new MasterAccessory(platform as never, accessory as never)
  const hvac = services.get(ServiceTokens.HeaterCooler)!
  const humidity = services.get(ServiceTokens.HumiditySensor)!

  return { state, commands, platform, master, hvac, humidity, services, removed }
}

describe('masterAccessory', () => {
  it('reports INACTIVE (not IDLE) for CurrentHeaterCoolerState when the unit is powered off', () => {
    const { state, master } = makeHarness()
    // Fixture: CompressorMode COOL, AmRunningFan true — with the unit on this would read COOLING.
    expect(master.getCurrentCompressorMode()).toBe(Characteristic.CurrentHeaterCoolerState.COOLING)

    state.applyDelta({ 'UserAirconSettings.isOn': false })
    expect(master.getCurrentCompressorMode()).toBe(Characteristic.CurrentHeaterCoolerState.INACTIVE)
  })

  it('pushes CurrentHeaterCoolerState to INACTIVE when the power path changes', () => {
    const { state, hvac } = makeHarness()
    hvac.updates.length = 0

    state.applyDelta({ 'UserAirconSettings.isOn': false })

    expect(hvac.updates.some(
      u => u.id === Characteristic.CurrentHeaterCoolerState && u.value === Characteristic.CurrentHeaterCoolerState.INACTIVE,
    )).toBe(true)
  })

  it('updates only the characteristics whose paths changed', () => {
    const { state, hvac } = makeHarness()
    hvac.updates.length = 0

    state.applyDelta({ 'UserAirconSettings.TemperatureSetpoint_Cool_oC': 24 })

    const ids = hvac.updates.map(u => u.id)
    expect(ids).toContain(Characteristic.CoolingThresholdTemperature)
    expect(hvac.updates.find(u => u.id === Characteristic.CoolingThresholdTemperature)?.value).toBe(24)
    expect(ids).not.toContain(Characteristic.RotationSpeed)
  })

  it('updates RotationSpeed when FanMode changes, and not on unrelated deltas', () => {
    const { state, hvac } = makeHarness()
    hvac.updates.length = 0

    state.applyDelta({ 'UserAirconSettings.FanMode': 'HIGH' })

    expect(hvac.updates.some(u => u.id === Characteristic.RotationSpeed && u.value === 90)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.CoolingThresholdTemperature)).toBe(false)
  })

  it('refuses writes while the system is offline', async () => {
    const { state, master } = makeHarness()
    state.setCloudConnected(false)

    await expect(master.setPowerState(1)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE })
  })

  it('throws a HAP communication error when the command queue reports FAILURE, instead of silently resolving', async () => {
    const { commands, master } = makeHarness()
    commands.run.mockResolvedValue('FAILURE')

    await expect(master.setPowerState(1)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE })
  })

  it('throws a HAP communication error when the command queue reports API_ERROR', async () => {
    const { commands, master } = makeHarness()
    commands.run.mockResolvedValue('API_ERROR')

    await expect(master.setCoolingThresholdTemperature(23)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE })
  })

  it('sends OFF then ON for Active changes', async () => {
    const { commands, master } = makeHarness()

    await master.setPowerState(0)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.OFF)

    await master.setPowerState(1)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ON)
  })

  it('reads Active, temperature and humidity synchronously from state', () => {
    const { master } = makeHarness()
    expect(master.getPowerState()).toBe(1)
    expect(master.getCurrentTemperature()).toBe(24)
    expect(master.getHumidity()).toBe(45)
    expect(master.getCoolingThresholdTemperature()).toBe(22)
    expect(master.getHeatingThresholdTemperature()).toBe(18)
  })

  it('reads RotationSpeed from every FanMode value', () => {
    const { state, master } = makeHarness()

    state.applyDelta({ 'UserAirconSettings.FanMode': 'LOW' })
    expect(master.getFanMode()).toBe(30)

    state.applyDelta({ 'UserAirconSettings.FanMode': 'MED' })
    expect(master.getFanMode()).toBe(60)

    state.applyDelta({ 'UserAirconSettings.FanMode': 'HIGH' })
    expect(master.getFanMode()).toBe(90)

    state.applyDelta({ 'UserAirconSettings.FanMode': 'AUTO' })
    expect(master.getFanMode()).toBe(100)
  })

  it('falls back to the built-in bounds when the device reports no limits of its own', () => {
    const { hvac } = makeHarness()

    const heat = hvac.getCharacteristic(Characteristic.HeatingThresholdTemperature)
    const cool = hvac.getCharacteristic(Characteristic.CoolingThresholdTemperature)

    expect(heat.props).toMatchObject({ minValue: 10, maxValue: 26 })
    expect(cool.props).toMatchObject({ minValue: 20, maxValue: 32 })
  })

  it('prefers the device-reported NV_Limits over the configured fallback, as the README promises', () => {
    // The owner's real hardware reports 16-30 for both modes, while the config defaults
    // offer cool 20-32 / heat 10-26: without this, 16-19°C cooling and 27-30°C heating are
    // unreachable and 31-32°C cooling is offered, sent, and silently clamped by the cloud.
    const { hvac } = makeHarness({}, { limits: { setCool_Min: 16, setCool_Max: 30, setHeat_Min: 16, setHeat_Max: 30 } })

    expect(hvac.getCharacteristic(Characteristic.HeatingThresholdTemperature).props)
      .toMatchObject({ minValue: 16, maxValue: 30 })
    expect(hvac.getCharacteristic(Characteristic.CoolingThresholdTemperature).props)
      .toMatchObject({ minValue: 16, maxValue: 30 })
  })

  it('clamps HeatingThresholdTemperature minValue to 10 even if the device reports lower', () => {
    const { hvac } = makeHarness({}, { limits: { setHeat_Min: 5, setHeat_Max: 30 } })
    const heat = hvac.getCharacteristic(Characteristic.HeatingThresholdTemperature)
    expect(heat.props.minValue).toBe(10)
  })

  it('sends fan mode commands mapped from RotationSpeed bands', async () => {
    const { commands, master } = makeHarness()

    await master.setFanMode(20)
    expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_LOW)

    await master.setFanMode(50)
    expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_MEDIUM)

    await master.setFanMode(80)
    expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_HIGH)

    await master.setFanMode(100)
    expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_AUTO)
  })

  it('refuses threshold and mode writes while offline', async () => {
    const { state, master } = makeHarness()
    state.setCloudConnected(false)

    await expect(master.setHeatingThresholdTemperature(19)).rejects.toBeTruthy()
    await expect(master.setCoolingThresholdTemperature(23)).rejects.toBeTruthy()
    await expect(master.setTargetClimateMode(Characteristic.TargetHeaterCoolerState.COOL)).rejects.toBeTruthy()
    await expect(master.setFanMode(50)).rejects.toBeTruthy()
  })

  it('treats a first-load "*" changed set as update everything', () => {
    // seed: false — construct the accessory (and its onChange subscription) BEFORE the
    // first replace(), so the '*' emission actually has a listener attached to observe it.
    const { state, hvac, humidity } = makeHarness({}, { seed: false })
    expect(hvac.updates).toHaveLength(0)

    state.replace(baseTree())

    expect(hvac.updates.some(u => u.id === Characteristic.Active && u.value === 1)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.TargetHeaterCoolerState && u.value === Characteristic.TargetHeaterCoolerState.COOL)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.RotationSpeed && u.value === 30)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.CoolingThresholdTemperature && u.value === 22)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.HeatingThresholdTemperature && u.value === 18)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.CurrentTemperature && u.value === 24)).toBe(true)
    expect(hvac.updates.some(u => u.id === Characteristic.CurrentHeaterCoolerState && u.value === 3)).toBe(true)
    expect(humidity.updates.some(u => u.id === Characteristic.CurrentRelativeHumidity && u.value === 45)).toBe(true)
  })

  describe('climate mode capability gating', () => {
    it('offers only the target states the unit reports supporting', () => {
      const capabilities = { ...fullCapabilities(), modes: { cool: true, heat: false, auto: false, fan: true, dry: false } }
      const { hvac } = makeHarness({}, { capabilities })

      const target = hvac.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      expect(target.props.validValues).toEqual([Characteristic.TargetHeaterCoolerState.COOL])
      // HAP's stored default is AUTO, which is illegal here — a legal value must be seeded.
      expect(target.value).toBe(Characteristic.TargetHeaterCoolerState.COOL)
    })

    it('still offers a usable thermostat, with a warning, when the unit reports no heat/cool/auto at all', () => {
      // HAP cannot accept an empty validValues list. capabilities reports the device honestly;
      // this is the one place that has to compromise, and it must say so.
      const capabilities = { ...fullCapabilities(), modes: { cool: false, heat: false, auto: false, fan: true, dry: false } }
      const { hvac, platform } = makeHarness({}, { capabilities })

      expect(hvac.getCharacteristic(Characteristic.TargetHeaterCoolerState).props.validValues).toHaveLength(3)
      expect(platform.log.warn).toHaveBeenCalledWith(expect.stringMatching(/no cooling, heating or auto mode/i))
    })

    it('never reports a target state outside validValues, even if the device reports that mode', () => {
      const capabilities = { ...fullCapabilities(), modes: { cool: true, heat: false, auto: true, fan: true, dry: false } }
      const { state, master } = makeHarness({}, { capabilities })

      state.applyDelta({ 'UserAirconSettings.Mode': 'HEAT' })

      // Holds the last state HAP will accept (COOL, from the fixture) rather than reporting a
      // HEAT that validValues excludes — HAP rejects that outright.
      expect(master.getTargetClimateMode()).toBe(Characteristic.TargetHeaterCoolerState.COOL)
    })
  })

  describe('fan-only mode', () => {
    it('reports the Fanv2 service active only while the unit is on and in FAN mode', () => {
      const { state, master } = makeHarness()
      expect(master.getFanOnlyActive()).toBe(Characteristic.Active.INACTIVE)

      state.applyDelta({ 'UserAirconSettings.Mode': 'FAN' })
      expect(master.getFanOnlyActive()).toBe(Characteristic.Active.ACTIVE)

      state.applyDelta({ 'UserAirconSettings.isOn': false })
      expect(master.getFanOnlyActive()).toBe(Characteristic.Active.INACTIVE)
    })

    it('holds the last real target state (and logs nothing) while the unit is in FAN mode', () => {
      const { state, master, platform } = makeHarness()
      expect(master.getTargetClimateMode()).toBe(Characteristic.TargetHeaterCoolerState.COOL)

      state.applyDelta({ 'UserAirconSettings.Mode': 'FAN' })

      expect(master.getTargetClimateMode()).toBe(Characteristic.TargetHeaterCoolerState.COOL)
      expect(platform.log.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed To Get Master Target Climate Mode'),
        expect.anything(),
      )
    })

    it('still logs an unrecognised mode, so a genuinely unknown value is not swallowed', () => {
      const { state, master, platform } = makeHarness()
      state.applyDelta({ 'UserAirconSettings.Mode': 'NONSENSE' })

      master.getTargetClimateMode()

      expect(platform.log.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed To Get Master Target Climate Mode'),
        'NONSENSE',
      )
    })

    it('switches to FAN mode and powers up in a single command, not two racing ones', async () => {
      // Two commands (ON + CLIMATE_MODE_FAN) land on different debounce keys, so a thermostat
      // mode arriving in the same window can replace the FAN half and the power half then
      // switches the unit on in whatever mode won.
      const { state, commands, master } = makeHarness()
      state.applyDelta({ 'UserAirconSettings.isOn': false })

      await master.setFanOnlyActive(Characteristic.Active.ACTIVE)

      expect(commands.run).toHaveBeenCalledTimes(1)
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_ONLY_ON)
    })

    it('switches to FAN mode when the unit is already running in another mode', async () => {
      const { commands, master } = makeHarness()

      await master.setFanOnlyActive(Characteristic.Active.ACTIVE)

      expect(commands.run).toHaveBeenCalledTimes(1)
      expect(commands.run).toHaveBeenCalledWith(NeoCommand.FAN_ONLY_ON)
    })

    it('does not re-send the mode when the unit is already running fan-only', async () => {
      const { state, commands, master } = makeHarness()
      state.applyDelta({ 'UserAirconSettings.Mode': 'FAN' })

      await master.setFanOnlyActive(Characteristic.Active.ACTIVE)

      expect(commands.run).not.toHaveBeenCalled()
    })

    it('powers the unit off when fan-only is turned off', async () => {
      const { state, commands, master } = makeHarness()
      state.applyDelta({ 'UserAirconSettings.Mode': 'FAN' })

      await master.setFanOnlyActive(Characteristic.Active.INACTIVE)

      expect(commands.run).toHaveBeenCalledWith(NeoCommand.OFF)
    })

    it('ignores an off write while the unit is in another mode, instead of shutting it down', async () => {
      // HomeKit sends Active=0 to the fan whenever the mode moves off FAN — treating that as
      // "turn the system off" would kill a cool/heat cycle the user just started.
      const { commands, master } = makeHarness()

      await master.setFanOnlyActive(Characteristic.Active.INACTIVE)

      expect(commands.run).not.toHaveBeenCalled()
    })

    it('pushes the Fanv2 characteristics when mode, power or fan speed change', () => {
      const { state, services } = makeHarness()
      const fan = services.get(ServiceTokens.Fanv2)!
      fan.updates.length = 0

      state.applyDelta({ 'UserAirconSettings.Mode': 'FAN' })
      expect(fan.updates.some(u => u.id === Characteristic.Active && u.value === Characteristic.Active.ACTIVE)).toBe(true)

      fan.updates.length = 0
      state.applyDelta({ 'UserAirconSettings.FanMode': 'HIGH' })
      expect(fan.updates.some(u => u.id === Characteristic.RotationSpeed && u.value === 90)).toBe(true)
    })

    it('gives the fan tile its own ConfiguredName, declared optional so HAP does not warn', () => {
      // The Home app seeds a service's name from the accessory name and syncs per-service names
      // through ConfiguredName (iOS 16+), so Name alone leaves the fan tile reading "Master".
      const { services } = makeHarness()
      const fan = services.get(ServiceTokens.Fanv2)!

      expect(fan.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Master Fan')
      expect(fan.declaredOptional).toContain(Characteristic.ConfiguredName)
    })

    it('leaves a ConfiguredName the Home app already holds alone, rather than clobbering a rename', () => {
      const { services } = makeHarness({}, {
        cachedServices: [ServiceTokens.Fanv2],
        seedCached: service => service.setCharacteristic(Characteristic.ConfiguredName, 'Lounge Breeze'),
      })
      const fan = services.get(ServiceTokens.Fanv2)!

      expect(fan.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Lounge Breeze')
    })

    it('seeds ConfiguredName on a fan service cached from before it was set, which would otherwise never get one', () => {
      const { services } = makeHarness({}, { cachedServices: [ServiceTokens.Fanv2] })
      const fan = services.get(ServiceTokens.Fanv2)!

      expect(fan.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Master Fan')
    })

    it('adds no fan service for a unit that does not support fan-only, and drops a cached one', () => {
      const capabilities = { ...fullCapabilities(), modes: { cool: true, heat: true, auto: true, fan: false, dry: false } }
      const { services, removed } = makeHarness({}, { capabilities, cachedServices: [ServiceTokens.Fanv2] })

      expect(removed).toEqual([ServiceTokens.Fanv2])
      expect(services.has(ServiceTokens.Fanv2)).toBe(false)
    })
  })

  describe('fan speed capability gating (spec: task-20)', () => {
    it('maps the RotationSpeed slider across halves for a 2-speed unit (LOW/MED, no AUTO), and round-trips', async () => {
      const capabilities: NeoCapabilities = { ...fullCapabilities(), fanSpeeds: [FanMode.LOW, FanMode.MEDIUM], supportsAutoFan: false }
      const { state, commands, master } = makeHarness({}, { capabilities })

      await master.setFanMode(40)
      expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_LOW)
      await master.setFanMode(100)
      expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_MEDIUM)

      // Round-trip: getFanMode() must report a value that setFanMode() maps back to the
      // same speed.
      state.applyDelta({ 'UserAirconSettings.FanMode': 'LOW' })
      expect(master.getFanMode()).toBe(50)
      state.applyDelta({ 'UserAirconSettings.FanMode': 'MED' })
      expect(master.getFanMode()).toBe(100)
    })

    it('maps the RotationSpeed slider across thirds for a 3-speed unit (LOW/MED/HIGH, no AUTO), and round-trips', () => {
      const capabilities: NeoCapabilities = { ...fullCapabilities(), fanSpeeds: [FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH], supportsAutoFan: false }
      const { state, master } = makeHarness({}, { capabilities })
      state.applyDelta({ 'UserAirconSettings.FanMode': 'LOW' })
      expect(master.getFanMode()).toBe(33)
      state.applyDelta({ 'UserAirconSettings.FanMode': 'MED' })
      expect(master.getFanMode()).toBe(67)
      state.applyDelta({ 'UserAirconSettings.FanMode': 'HIGH' })
      expect(master.getFanMode()).toBe(100)
    })

    it('never emits FAN_MODE_AUTO at the top of the slider on the owner\'s real fixture (bitmap 3, current HIGH, no AUTO support)', async () => {
      const fixture = StatusResponseSchema.parse(JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8')))
      const probe = new NeoState()
      probe.replace(fixture.lastKnownState)
      const capabilities = deriveCapabilities(probe)

      expect(capabilities.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])
      expect(capabilities.supportsAutoFan).toBe(false)

      const { state, commands, master } = makeHarness({}, { capabilities, seed: false })
      state.replace(fixture.lastKnownState)

      await master.setFanMode(100)
      expect(commands.run).toHaveBeenLastCalledWith(NeoCommand.FAN_MODE_HIGH)
      expect(commands.run).not.toHaveBeenCalledWith(NeoCommand.FAN_MODE_AUTO)
    })

    it('regression: setFanMode does not throw when capabilities are degraded to an empty fanSpeeds list', async () => {
      const capabilities: NeoCapabilities = { ...fullCapabilities(), fanSpeeds: [], supportsAutoFan: false }
      const { commands, master } = makeHarness({}, { capabilities })

      await expect(master.setFanMode(100)).resolves.toBeUndefined()
      expect(commands.run).toHaveBeenCalled()
      expect(() => master.getFanMode()).not.toThrow()
    })
  })
})

describe('setpoint characteristics stay inside the range HAP was told about', () => {
  // Regression: HeatingThresholdTemperature starts at HAP's default of 0 and Cooling at 10.
  // Tightening minValue to the device's own floor (16 on the owner's NTW-1000) without
  // seeding a value made HAP reject the stored one — "supplied illegal value: number 0
  // exceeded minimum of 16" on every startup.
  const deviceLimits = { setCool_Min: 16, setCool_Max: 30, setHeat_Min: 16, setHeat_Max: 30 }

  it('seeds a legal value at construction rather than leaving the HAP default in place', () => {
    const { hvac } = makeHarness({}, { limits: deviceLimits })

    for (const id of [Characteristic.HeatingThresholdTemperature, Characteristic.CoolingThresholdTemperature]) {
      const c = hvac.getCharacteristic(id)
      expect(typeof c.value).toBe('number')
      expect(c.value as number).toBeGreaterThanOrEqual(c.props.minValue as number)
      expect(c.value as number).toBeLessThanOrEqual(c.props.maxValue as number)
    }
  })

  it('clamps into range when the device reports no setpoint at all', () => {
    const { state, master } = makeHarness({}, { limits: deviceLimits })
    state.replace({ ...baseTree(), NV_Limits: { UserSetpoint_oC: deviceLimits }, UserAirconSettings: {} } as never)

    // Without clamping these fall back to 0 and 10 — both below the device's 16 floor.
    expect(master.getHeatingThresholdTemperature()).toBe(16)
    expect(master.getCoolingThresholdTemperature()).toBe(16)
  })

  it('clamps a setpoint the device reports outside its own limits', () => {
    const { state, master } = makeHarness({}, { limits: deviceLimits })
    state.replace({
      ...baseTree(),
      NV_Limits: { UserSetpoint_oC: deviceLimits },
      UserAirconSettings: { TemperatureSetpoint_Heat_oC: 4, TemperatureSetpoint_Cool_oC: 99 },
    } as never)

    expect(master.getHeatingThresholdTemperature()).toBe(16)
    expect(master.getCoolingThresholdTemperature()).toBe(30)
  })

  it('passes a valid setpoint through untouched', () => {
    const { state, master } = makeHarness({}, { limits: deviceLimits })
    state.replace({
      ...baseTree(),
      NV_Limits: { UserSetpoint_oC: deviceLimits },
      UserAirconSettings: { TemperatureSetpoint_Heat_oC: 21, TemperatureSetpoint_Cool_oC: 23.5 },
    } as never)

    expect(master.getHeatingThresholdTemperature()).toBe(21)
    expect(master.getCoolingThresholdTemperature()).toBe(23.5)
  })
})

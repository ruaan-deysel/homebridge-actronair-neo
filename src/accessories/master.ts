import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import type { ActronAirNeoPlatform } from '../platform.js'
import { HAPStatus } from 'homebridge'
import { getUsableMasterHumidity, getUsableMasterTemp, resolveSetpointBounds } from '../neo/capabilities.js'
import { ClimateMode, CompressorMode, FanMode, NeoCommand } from '../neo/types.js'
import { assertCommandSuccess } from './assertCommandResult.js'

/** Paths this accessory's characteristics depend on. Anything else is another accessory's business. */
const WATCHED = {
  power: 'UserAirconSettings.isOn',
  mode: 'UserAirconSettings.Mode',
  fanMode: 'UserAirconSettings.FanMode',
  coolSetpoint: 'UserAirconSettings.TemperatureSetpoint_Cool_oC',
  heatSetpoint: 'UserAirconSettings.TemperatureSetpoint_Heat_oC',
  currentTemp: 'MasterInfo.LiveTemp_oC',
  humidity: 'MasterInfo.LiveHumidity_pc',
  compressorMode: 'LiveAircon.CompressorMode',
  fanRunning: 'LiveAircon.AmRunningFan',
} as const

/** Plain (non +CONT) command for each fan speed the slider can select. */
const FAN_COMMAND: Partial<Record<FanMode, NeoCommand>> = {
  [FanMode.LOW]: NeoCommand.FAN_MODE_LOW,
  [FanMode.MEDIUM]: NeoCommand.FAN_MODE_MEDIUM,
  [FanMode.HIGH]: NeoCommand.FAN_MODE_HIGH,
  [FanMode.AUTO]: NeoCommand.FAN_MODE_AUTO,
}

/** One RotationSpeed band per supported fan speed, in ascending order. */
interface FanBand { speed: FanMode, max: number }

/**
 * Splits the 0-100 RotationSpeed slider into one band per supported speed. When AUTO is
 * supported it keeps today's behaviour: AUTO owns the top 91-100 band and the remaining
 * speeds split 0-90 evenly (which, for the historical 4-speed case, reproduces the old
 * hardcoded 30/60/90/100 thresholds exactly). Without AUTO, all supported speeds split
 * 0-100 evenly.
 */
function computeFanBands(speeds: FanMode[]): FanBand[] {
  // Defense in depth: deriveCapabilities() never returns an empty fanSpeeds list, but a
  // characteristic handler crashing on the fan slider is bad enough that this can't rely
  // solely on the caller upholding that invariant.
  const safeSpeeds = speeds.length ? speeds : [FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH]
  const hasAuto = safeSpeeds.includes(FanMode.AUTO)
  const base: FanMode[] = safeSpeeds.filter(s => s !== FanMode.AUTO)
  const ceiling = hasAuto ? 90 : 100
  const bands = base.map((speed, i) => ({ speed, max: Math.round((ceiling * (i + 1)) / base.length) }))
  if (hasAuto)
    bands.push({ speed: FanMode.AUTO, max: 100 })
  return bands
}

/**
 * Keep a setpoint inside the range HAP was told about. A device that reports no setpoint (or
 * reports one outside its own limits) must not produce a value HAP rejects — the alternative
 * is an "illegal value" warning on every update and a characteristic HomeKit won't display.
 */
function clampToBounds(value: number | undefined, bounds: { min: number, max: number }): number {
  if (value === undefined || !Number.isFinite(value))
    return bounds.min
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

export class MasterAccessory {
  private readonly hvacService: Service
  private readonly humidityService: Service
  /**
   * Fan-only mode. HomeKit's HeaterCooler has no target state for it (Off/Heat/Cool/Auto is
   * the whole set), so a unit that reports ModeSupport.Fan gets a Fanv2 service alongside the
   * thermostat instead — the mode is otherwise unreachable from the Home app, and a unit left
   * in it from the ActronAir app showed up as whatever mode HomeKit last saw.
   * Absent when the unit doesn't support fan-only.
   */
  private readonly fanOnlyService?: Service
  private readonly fanBands: FanBand[]
  /** TargetHeaterCoolerState values this unit accepts — HAP rejects anything outside them. */
  private readonly climateTargets: number[]
  /**
   * The heat/cool/auto target the thermostat last had. While the unit is in FAN mode there is
   * no honest value to report (fan-only is neither heating nor cooling, and HAP has no state
   * for it), so the thermostat holds this one and the Fanv2 service carries the truth.
   */
  private lastClimateTarget: number
  /** Effective setpoint range per mode, resolved from the device once at construction. */
  private heatBounds!: { min: number, max: number }
  private coolBounds!: { min: number, max: number }
  /**
   * Last known-good readings. The cloud reports a 3000 sentinel (and other implausible
   * values) for a sensor that isn't answering; serving that raw would push a value HAP caps
   * at 100 into CurrentTemperature and log "supplied illegal value" on every update. Same
   * last-known-good pattern as accessories/outdoorTemp.ts.
   */
  private lastGoodTemp: number | undefined
  private lastGoodHumidity: number | undefined

  constructor(
    private readonly platform: ActronAirNeoPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Capabilities are derived once at startup before any accessory is built; the fallback
    // here only guards a construction ordering bug, never a real unknown-model case.
    this.fanBands = computeFanBands(this.platform.capabilities?.fanSpeeds ?? [FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Actron')
      .setCharacteristic(this.platform.Characteristic.Model, this.platform.capabilities?.model ?? 'ActronAir Neo Master Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.platform.serial)

    this.hvacService = this.accessory.getService(this.platform.Service.HeaterCooler)
      || this.accessory.addService(this.platform.Service.HeaterCooler)

    this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor)
      || this.accessory.addService(this.platform.Service.HumiditySensor)

    this.hvacService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName)

    this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getHumidity.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setPowerState.bind(this))
      .onGet(this.getPowerState.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentCompressorMode.bind(this))

    // Only offer the modes the unit reports. Without this a unit that can't heat (or can't run
    // AUTO) still showed the mode in the Home app, and picking it sent a command the cloud
    // acknowledged and the hardware ignored. AUTO first so it stays the value HAP defaults to.
    const target = this.platform.Characteristic.TargetHeaterCoolerState
    const modes = this.platform.capabilities?.modes
    const reportedTargets = [
      ...(modes?.auto ?? true ? [target.AUTO] : []),
      ...(modes?.heat ?? true ? [target.HEAT] : []),
      ...(modes?.cool ?? true ? [target.COOL] : []),
    ]
    // HAP needs at least one valid value or the characteristic — and with it the thermostat —
    // is unusable, so a unit reporting no heating, cooling or auto at all (a fan-only head)
    // still gets the full set rather than an empty list. Loudly, because every mode offered
    // will then be one the hardware rejects: capabilities reports the device honestly and this
    // is the one place that has to compromise.
    if (reportedTargets.length === 0) {
      this.platform.log.warn(
        'This unit reports no cooling, heating or auto mode. HomeKit cannot show a thermostat without one, so all three are being offered — expect the unit to ignore them.',
      )
    }
    this.climateTargets = reportedTargets.length ? reportedTargets : [target.AUTO, target.HEAT, target.COOL]
    this.lastClimateTarget = this.climateTargets[0]

    this.hvacService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: this.climateTargets })
      // As with the setpoints below: HAP's stored default (AUTO) is illegal on a unit that
      // doesn't support it, and would warn on every startup unless a valid value is seeded.
      .updateValue(this.getTargetClimateMode())
      .onGet(this.getTargetClimateMode.bind(this))
      .onSet(this.setTargetClimateMode.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))

    // Device-reported limits win over the built-in fallback — see resolveSetpointBounds().
    const heatBounds = resolveSetpointBounds(this.platform.state, 'heat')
    const coolBounds = resolveSetpointBounds(this.platform.state, 'cool')
    this.heatBounds = { min: Math.max(10, heatBounds.min), max: heatBounds.max }
    this.coolBounds = coolBounds

    // Both characteristics start at a HAP default below these minimums (0 for heating, 10 for
    // cooling), so tightening the range without seeding a valid value makes HAP reject the
    // stored one and warn on every startup. The getters clamp for the same reason: a device
    // that doesn't report a setpoint must not fall back to a value outside its own limits.
    this.hvacService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: this.heatBounds.min,
        maxValue: this.heatBounds.max,
        minStep: 0.5,
      })
      .updateValue(this.getHeatingThresholdTemperature())
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .onSet(this.setHeatingThresholdTemperature.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: this.coolBounds.min,
        maxValue: this.coolBounds.max,
        minStep: 0.5,
      })
      .updateValue(this.getCoolingThresholdTemperature())
      .onGet(this.getCoolingThresholdTemperature.bind(this))
      .onSet(this.setCoolingThresholdTemperature.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setFanMode.bind(this))
      .onGet(this.getFanMode.bind(this))

    const cachedFanOnly = this.accessory.getService(this.platform.Service.Fanv2)
    if (modes?.fan ?? true) {
      this.fanOnlyService = cachedFanOnly ?? this.accessory.addService(this.platform.Service.Fanv2)
      const fanName = `${accessory.displayName} Fan`
      this.fanOnlyService.setCharacteristic(this.platform.Characteristic.Name, fanName)

      // `Name` alone is not enough for the Home app. Since iOS 16 it seeds each service's name
      // from the *accessory* name and syncs per-service names through ConfiguredName, so without
      // this the fan tile reads "ActronAir Neo" — indistinguishable from the thermostat beside
      // it. Declared optional first because ConfiguredName isn't in Fanv2's HAP definition and
      // getCharacteristic() would otherwise log a characteristic warning every startup.
      //
      // Seeded only when it has no value yet — on a fresh service, or on one cached from before
      // this existed. Never re-set once it holds something: the Home app writes a user's rename
      // back into this same characteristic, and re-applying it every startup is a well-trodden
      // way to clobber their choice on every restart. That is also why a later rename in the
      // plugin config moves `Name` but leaves an established ConfiguredName alone.
      const configured = this.fanOnlyService.testCharacteristic(this.platform.Characteristic.ConfiguredName)
      if (!configured)
        this.fanOnlyService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName)
      if (!configured || !this.fanOnlyService.getCharacteristic(this.platform.Characteristic.ConfiguredName).value)
        this.fanOnlyService.setCharacteristic(this.platform.Characteristic.ConfiguredName, fanName)

      this.fanOnlyService.getCharacteristic(this.platform.Characteristic.Active)
        .onGet(this.getFanOnlyActive.bind(this))
        .onSet(this.setFanOnlyActive.bind(this))

      // Same fan speed as the thermostat's slider, deliberately — there is one FanMode on the
      // wire, and fan-only mode is where a user most wants to reach it.
      this.fanOnlyService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .onGet(this.getFanMode.bind(this))
        .onSet(this.setFanMode.bind(this))
    }
    else if (cachedFanOnly) {
      // Cached from a run where the unit did report fan support (or from before this gate
      // existed) — leaving it would show a fan tile that can't do anything.
      this.accessory.removeService(cachedFanOnly)
    }

    // Single poll loop lives on the platform now; this replaces the two setInterval timers.
    this.platform.state.onChange(changed => this.pushCharacteristics(changed))
  }

  private pushCharacteristics(changed: Set<string>): void {
    const all = changed.has('*')

    if (all || changed.has(WATCHED.power))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.Active, this.getPowerState())

    if (all || changed.has(WATCHED.mode))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.getTargetClimateMode())

    if (all || changed.has(WATCHED.fanMode))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getFanMode())

    if (all || changed.has(WATCHED.coolSetpoint))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.getCoolingThresholdTemperature())

    if (all || changed.has(WATCHED.heatSetpoint))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.getHeatingThresholdTemperature())

    if (all || changed.has(WATCHED.currentTemp))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature())

    if (all || changed.has(WATCHED.humidity))
      this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.getHumidity())

    if (all || changed.has(WATCHED.power) || changed.has(WATCHED.compressorMode) || changed.has(WATCHED.fanRunning))
      this.hvacService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.getCurrentCompressorMode())

    if (this.fanOnlyService) {
      if (all || changed.has(WATCHED.power) || changed.has(WATCHED.mode))
        this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.Active, this.getFanOnlyActive())
      if (all || changed.has(WATCHED.fanMode))
        this.fanOnlyService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getFanMode())
    }
  }

  private checkHvacComms(): void {
    if (!this.platform.state.cloudConnected) {
      this.platform.log.error('Master Controller is offline. Check Master Controller Internet/Wifi connection')
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  getHumidity(): CharacteristicValue {
    const humidity = getUsableMasterHumidity(this.platform.state)
    if (humidity !== undefined)
      this.lastGoodHumidity = humidity
    // ponytail: 0 only until the first real reading ever arrives — unlike outdoorTemp.ts this
    // characteristic sits on the main accessory, where throwing would take the whole
    // thermostat down rather than one standalone sensor.
    return this.lastGoodHumidity ?? 0
  }

  async setPowerState(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    assertCommandSuccess(this.platform, await this.platform.commands.run(value === 1 ? NeoCommand.ON : NeoCommand.OFF))
    this.platform.log.debug('Set Master Power State -> ', value)
  }

  getPowerState(): CharacteristicValue {
    return this.platform.state.get<boolean>(WATCHED.power) ? 1 : 0
  }

  getCurrentCompressorMode(): CharacteristicValue {
    const { INACTIVE, IDLE, HEATING, COOLING } = this.platform.Characteristic.CurrentHeaterCoolerState

    // The unit being off is authoritative — a stale/idle compressor reading must never
    // report IDLE (i.e. "on but not actively conditioning") while the system is powered off.
    if (!this.platform.state.get<boolean>(WATCHED.power))
      return INACTIVE

    let currentMode: number
    const compressorMode = this.platform.state.get<string>(WATCHED.compressorMode)
    switch (compressorMode) {
      case CompressorMode.OFF:
        currentMode = IDLE
        break
      case CompressorMode.HEAT:
        currentMode = HEATING
        break
      case CompressorMode.COOL:
        currentMode = COOLING
        break
      default:
        currentMode = IDLE
        this.platform.log.debug('Failed To Get Master Valid Compressor Mode -> ', compressorMode)
    }
    if (!this.platform.state.get<boolean>(WATCHED.fanRunning)) {
      currentMode = IDLE
    }
    return currentMode
  }

  async setTargetClimateMode(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    switch (value) {
      case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
        assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.CLIMATE_MODE_AUTO))
        break
      case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
        assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.CLIMATE_MODE_HEAT))
        break
      case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
        assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.CLIMATE_MODE_COOL))
        break
      default:
        this.platform.log.debug('Failed To Set Master Climate Mode -> ', value)
    }
    this.platform.log.debug('Set Master Climate Mode -> ', value)
  }

  /**
   * FAN is deliberately not an error case: the unit really can be in fan-only mode, and the
   * Fanv2 service reports it. The thermostat holds its previous target rather than inventing
   * one — and never reports a mode `validValues` excludes, which HAP would reject outright.
   */
  getTargetClimateMode(): CharacteristicValue {
    const { AUTO, HEAT, COOL } = this.platform.Characteristic.TargetHeaterCoolerState
    const climateMode = this.platform.state.get<string>(WATCHED.mode)
    const mapped = climateMode === ClimateMode.AUTO
      ? AUTO
      : climateMode === ClimateMode.HEAT
        ? HEAT
        : climateMode === ClimateMode.COOL
          ? COOL
          : undefined

    if (mapped !== undefined && this.climateTargets.includes(mapped))
      this.lastClimateTarget = mapped
    else if (climateMode !== ClimateMode.FAN)
      this.platform.log.debug('Failed To Get Master Target Climate Mode -> ', climateMode)

    return this.lastClimateTarget
  }

  /** Fan-only is on when the unit is running *and* in FAN mode — see fanOnlyService. */
  getFanOnlyActive(): CharacteristicValue {
    const { ACTIVE, INACTIVE } = this.platform.Characteristic.Active
    return this.platform.state.get<boolean>(WATCHED.power)
      && this.platform.state.get<string>(WATCHED.mode) === ClimateMode.FAN
      ? ACTIVE
      : INACTIVE
  }

  /**
   * Turning fan-only on switches the unit to FAN mode and powers it up, in one command
   * (`FAN_ONLY_ON`) — two separately debounced commands could be split by a mode change
   * arriving in the same window, see its builder. Turning it off powers the unit down, because
   * fan-only *is* the unit running: there is no fan to stop independently. Off while the unit
   * is in some other mode is a no-op rather than a surprise shutdown.
   */
  async setFanOnlyActive(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    const on = Number(value) === this.platform.Characteristic.Active.ACTIVE

    if (on) {
      // Already running fan-only: nothing to send, and re-sending would cost a cloud write.
      if (this.getFanOnlyActive() === this.platform.Characteristic.Active.ACTIVE)
        return
      assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.FAN_ONLY_ON))
    }
    else if (this.platform.state.get<string>(WATCHED.mode) === ClimateMode.FAN) {
      assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.OFF))
    }
    this.platform.log.debug('Set Master Fan-Only Mode -> ', on)
  }

  getCurrentTemperature(): CharacteristicValue {
    const temp = getUsableMasterTemp(this.platform.state)
    if (temp !== undefined)
      this.lastGoodTemp = temp
    return this.lastGoodTemp ?? 0
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    // Note: no forced re-poll here. The command already updates local state optimistically,
    // and the cloud's status endpoint lags behind — refreshing now would clobber the value
    // we just set with a stale reading. The periodic poll reconciles once the cloud catches up.
    assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.HEAT_SET_POINT, { heatTemp: value as number }))
    this.platform.log.debug('Set Master Target Heating Temperature -> ', value)
  }

  getHeatingThresholdTemperature(): CharacteristicValue {
    return clampToBounds(this.platform.state.get<number>(WATCHED.heatSetpoint), this.heatBounds)
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    // Note: no forced re-poll here (see setHeatingThresholdTemperature) - it would clobber
    // the value we just set with a stale cloud reading.
    assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.COOL_SET_POINT, { coolTemp: value as number }))
    this.platform.log.debug('Set Master Target Cooling Temperature -> ', value)
  }

  getCoolingThresholdTemperature(): CharacteristicValue {
    return clampToBounds(this.platform.state.get<number>(WATCHED.coolSetpoint), this.coolBounds)
  }

  async setFanMode(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    const numericValue = Number(value)

    if (Number.isNaN(numericValue)) {
      this.platform.log.error('Invalid fan mode value')
      return
    }

    const band = this.fanBands.find(b => numericValue <= b.max) ?? this.fanBands[this.fanBands.length - 1]
    assertCommandSuccess(this.platform, await this.platform.commands.run(FAN_COMMAND[band.speed] ?? NeoCommand.FAN_MODE_LOW))
    this.platform.log.debug(`Set Master Fan Mode (bands: ${this.fanBands.map(b => `${b.speed}<=${b.max}`).join(', ')}) -> `, value)
  }

  getFanMode(): CharacteristicValue {
    const fanMode = this.platform.state.get<string>(WATCHED.fanMode)
    const baseMode = fanMode?.replace('+CONT', '') as FanMode | undefined
    const band = this.fanBands.find(b => b.speed === baseMode)
    if (!band) {
      this.platform.log.debug('Failed To Get Master Current Fan Mode -> ', fanMode)
      return 0
    }
    return band.max
  }
}

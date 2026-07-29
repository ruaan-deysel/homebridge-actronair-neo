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

export class MasterAccessory {
  private readonly hvacService: Service
  private readonly humidityService: Service
  private readonly fanBands: FanBand[]
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

    this.hvacService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.getTargetClimateMode.bind(this))
      .onSet(this.setTargetClimateMode.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))

    // Device-reported limits win over the configured fallback — see resolveSetpointBounds().
    const heatBounds = resolveSetpointBounds(this.platform.state, 'heat')
    const coolBounds = resolveSetpointBounds(this.platform.state, 'cool')

    this.hvacService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: Math.max(10, heatBounds.min),
        maxValue: heatBounds.max,
        minStep: 0.5,
      })
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .onSet(this.setHeatingThresholdTemperature.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: coolBounds.min,
        maxValue: coolBounds.max,
        minStep: 0.5,
      })
      .onGet(this.getCoolingThresholdTemperature.bind(this))
      .onSet(this.setCoolingThresholdTemperature.bind(this))

    this.hvacService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setFanMode.bind(this))
      .onGet(this.getFanMode.bind(this))

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

  getTargetClimateMode(): CharacteristicValue {
    let currentMode: number
    const climateMode = this.platform.state.get<string>(WATCHED.mode)
    switch (climateMode) {
      case ClimateMode.AUTO:
        currentMode = this.platform.Characteristic.TargetHeaterCoolerState.AUTO
        break
      case ClimateMode.HEAT:
        currentMode = this.platform.Characteristic.TargetHeaterCoolerState.HEAT
        break
      case ClimateMode.COOL:
        currentMode = this.platform.Characteristic.TargetHeaterCoolerState.COOL
        break
      default:
        currentMode = 0
        this.platform.log.debug('Failed To Get Master Target Climate Mode -> ', climateMode)
    }
    return currentMode
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
    return this.platform.state.get<number>(WATCHED.heatSetpoint) ?? 0
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    // Note: no forced re-poll here (see setHeatingThresholdTemperature) - it would clobber
    // the value we just set with a stale cloud reading.
    assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.COOL_SET_POINT, { coolTemp: value as number }))
    this.platform.log.debug('Set Master Target Cooling Temperature -> ', value)
  }

  getCoolingThresholdTemperature(): CharacteristicValue {
    return this.platform.state.get<number>(WATCHED.coolSetpoint) ?? 0
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

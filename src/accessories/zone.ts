import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import type { UserSetpointLimits } from '../neo/capabilities.js'
import type { ActronAirNeoPlatform } from '../platform.js'
import { HAPStatus } from 'homebridge'
import { getUsableZoneHumidity, getUsableZoneTemp, getUserSetpointLimits, resolveSetpointBounds } from '../neo/capabilities.js'
import { resolveZoneSensor } from '../neo/sensors.js'
import { ClimateMode, CompressorMode, NeoCommand } from '../neo/types.js'
import { assertCommandSuccess } from './assertCommandResult.js'

export class ZoneAccessory {
  private readonly zoneService: Service
  private humidityService: Service | undefined
  /** Switch mode only — HeaterCooler mode already carries CurrentTemperature itself. */
  private temperatureService: Service | undefined
  /** Only present for a wireless zone sensor whose serial resolves to a real battery reading. */
  private batteryService: Service | undefined
  /**
   * Last known-good battery reading. BatteryLevel is a required characteristic once the
   * service exists, but a momentarily-missing peripheral must never fabricate a number —
   * see resolveZoneSensor()/neo/sensors.ts. The service itself is only ever added after a
   * real reading has been seen (see the constructor), so this is populated before first use.
   */
  private lastGoodBattery: number | undefined
  /** Same rule for temperature/humidity — see getCurrentTemperature(). */
  private lastGoodTemp: number | undefined
  private lastGoodHumidity: number | undefined

  private readonly paths: {
    name: string
    coolSetpoint: string
    heatSetpoint: string
  }

  constructor(
    private readonly platform: ActronAirNeoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly zoneIndex: number,
  ) {
    const zi = this.zoneIndex
    this.paths = {
      name: `RemoteZoneInfo[${zi}].NV_Title`,
      coolSetpoint: `RemoteZoneInfo[${zi}].TemperatureSetpoint_Cool_oC`,
      heatSetpoint: `RemoteZoneInfo[${zi}].TemperatureSetpoint_Heat_oC`,
    }

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Actron')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.platform.capabilities?.model ?? 'ActronAir Neo'} Zone Controller`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${this.platform.serial}-zone-${zi}`)

    const tempUsable = getUsableZoneTemp(this.platform.state, zi) !== undefined
    const humidityUsable = getUsableZoneHumidity(this.platform.state, zi) !== undefined
    const sensorInfo = resolveZoneSensor(this.platform.state, zi)
    const batteryUsable = sensorInfo.kind === 'wireless' && sensorInfo.batteryPct !== undefined

    if (this.platform.cfg.zonesAsHeaterCoolers) {
      const existingSwitch = this.accessory.getService(this.platform.Service.Switch)
      if (existingSwitch)
        this.accessory.removeService(existingSwitch)

      this.zoneService = this.accessory.getService(this.platform.Service.HeaterCooler)
        || this.accessory.addService(this.platform.Service.HeaterCooler)

      // HeaterCooler already carries CurrentTemperature — a standalone TemperatureSensor
      // would show the same reading twice in the Home app, so it never applies here.
      const existingTempSensor = this.accessory.getService(this.platform.Service.TemperatureSensor)
      if (existingTempSensor)
        this.accessory.removeService(existingTempSensor)
      this.temperatureService = undefined
    }
    else {
      const existingHeaterCooler = this.accessory.getService(this.platform.Service.HeaterCooler)
      if (existingHeaterCooler)
        this.accessory.removeService(existingHeaterCooler)

      this.zoneService = this.accessory.getService(this.platform.Service.Switch)
        || this.accessory.addService(this.platform.Service.Switch)

      if (tempUsable) {
        this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
          || this.accessory.addService(this.platform.Service.TemperatureSensor)
      }
      else {
        const existingTempSensor = this.accessory.getService(this.platform.Service.TemperatureSensor)
        if (existingTempSensor)
          this.accessory.removeService(existingTempSensor)
        this.temperatureService = undefined
      }
    }

    // Humidity is gated on availability in both modes — not every sensor model reports it,
    // and a fabricated percentage is worse than an absent accessory (see getUsableZoneHumidity).
    if (humidityUsable) {
      this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor)
        || this.accessory.addService(this.platform.Service.HumiditySensor)
    }
    else {
      const existingHumidity = this.accessory.getService(this.platform.Service.HumiditySensor)
      if (existingHumidity)
        this.accessory.removeService(existingHumidity)
      this.humidityService = undefined
    }

    // Battery service: only a wireless zone sensor whose serial resolves to a real reading
    // (see resolveZoneSensor). Wired sensors have no battery at all, and an unresolvable
    // wireless serial must never fall back to a fabricated level.
    if (batteryUsable) {
      this.batteryService = this.accessory.getService(this.platform.Service.Battery)
        || this.accessory.addService(this.platform.Service.Battery)
      this.lastGoodBattery = sensorInfo.batteryPct
    }
    else {
      const existingBattery = this.accessory.getService(this.platform.Service.Battery)
      if (existingBattery)
        this.accessory.removeService(existingBattery)
      this.batteryService = undefined
    }

    this.zoneService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName)

    if (this.platform.cfg.zonesAsHeaterCoolers) {
      this.zoneService.getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.setActiveState.bind(this))
        .onGet(this.getActiveState.bind(this))

      this.zoneService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
        .onGet(this.getCurrentHeaterCoolerState.bind(this))

      this.zoneService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
        .onGet(this.getTargetHeaterCoolerState.bind(this))

      this.zoneService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this))

      const heatBounds = this.heatBounds()
      this.zoneService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .setProps({
          minValue: Math.max(10, heatBounds.min),
          maxValue: heatBounds.max,
          minStep: 0.5,
        })
        .onGet(this.getHeatingThresholdTemperature.bind(this))
        .onSet(this.setHeatingThresholdTemperature.bind(this))

      const coolBounds = this.coolBounds()
      this.zoneService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
        .setProps({
          minValue: coolBounds.min,
          maxValue: coolBounds.max,
          minStep: 0.5,
        })
        .onGet(this.getCoolingThresholdTemperature.bind(this))
        .onSet(this.setCoolingThresholdTemperature.bind(this))
    }
    else {
      this.zoneService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setEnableState.bind(this))
        .onGet(this.getEnableState.bind(this))

      this.temperatureService?.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this))
    }

    this.humidityService?.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentHumidity.bind(this))

    // Connection-state visibility: a dropped sensor should read as "not responding" in the
    // Home app rather than silently keep serving a stale temperature/humidity value. Placed
    // on TemperatureSensor/HumiditySensor (both support the optional StatusActive
    // characteristic) — HeaterCooler does not support it, so a heater-cooler-mode zone
    // without a usable humidity reading has no service left to carry the signal.
    this.temperatureService?.getCharacteristic(this.platform.Characteristic.StatusActive)
      .onGet(this.getSensorActive.bind(this))
    this.humidityService?.getCharacteristic(this.platform.Characteristic.StatusActive)
      .onGet(this.getSensorActive.bind(this))

    this.batteryService?.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this))
    this.batteryService?.getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(this.getChargingState.bind(this))
    this.batteryService?.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.getLowBatteryStatus.bind(this))

    // Single poll loop lives on the platform now; react only to deltas that touch this zone.
    this.platform.state.onChange(changed => this.pushCharacteristics(changed))
  }

  private pushCharacteristics(changed: Set<string>): void {
    const zi = this.zoneIndex
    const prefix = `RemoteZoneInfo[${zi}].`
    const all = changed.has('*')
    const enabledChanged = changed.has('UserAirconSettings.EnabledZones')
      || changed.has(`UserAirconSettings.EnabledZones[${zi}]`)
    // getActiveState/getCurrentHeaterCoolerState/getTargetHeaterCoolerState all read these
    // master-level paths — without watching them, e.g. turning the master off leaves every
    // zone tile stale until something zone-specific also happens to change.
    const masterChanged = changed.has('UserAirconSettings.isOn')
      || changed.has('UserAirconSettings.Mode')
      || changed.has('LiveAircon.CompressorMode')
      || changed.has('LiveAircon.AmRunningFan')
    // AirconSystem.Peripherals/.Sensors carry battery/RSSI/connection for every zone's
    // sensor, keyed by serial/designator rather than zone index — not caught by the `prefix`
    // check above, so it needs its own watch.
    const sensorChanged = [...changed].some(p => p.startsWith('AirconSystem.Peripherals') || p.startsWith('AirconSystem.Sensors'))
    const mine = all || enabledChanged || masterChanged || sensorChanged
      || [...changed].some(p => p.startsWith(prefix))
    if (!mine)
      return

    if (this.platform.cfg.zonesAsHeaterCoolers) {
      this.zoneService.updateCharacteristic(this.platform.Characteristic.Active, this.getActiveState())
      this.zoneService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerState())
      this.zoneService.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerState())
      this.zoneService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature())
      this.zoneService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.getHeatingThresholdTemperature())
      this.zoneService.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.getCoolingThresholdTemperature())
    }
    else {
      this.zoneService.updateCharacteristic(this.platform.Characteristic.On, this.getEnableState())
      this.temperatureService?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature())
    }
    this.humidityService?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.getCurrentHumidity())
    this.temperatureService?.updateCharacteristic(this.platform.Characteristic.StatusActive, this.getSensorActive())
    this.humidityService?.updateCharacteristic(this.platform.Characteristic.StatusActive, this.getSensorActive())
    this.batteryService?.updateCharacteristic(this.platform.Characteristic.BatteryLevel, this.getBatteryLevel())
    this.batteryService?.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, this.getLowBatteryStatus())
  }

  private checkHvacComms(): void {
    if (!this.platform.state.cloudConnected) {
      this.platform.log.error('Master Controller is offline. Check Master Controller Internet/Wifi connection')
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  private zoneName(): string {
    return this.platform.state.get<string>(this.paths.name) ?? this.accessory.displayName
  }

  getEnabled(): boolean {
    return this.platform.state.get<boolean[]>('UserAirconSettings.EnabledZones')?.[this.zoneIndex] ?? false
  }

  /**
   * Never fabricated: the Battery service only exists (see constructor) once a real reading
   * has been seen, and lastGoodBattery is seeded at that point — a momentarily-missing
   * peripheral serves the last real value instead of inventing one.
   */
  getBatteryLevel(): CharacteristicValue {
    const pct = resolveZoneSensor(this.platform.state, this.zoneIndex).batteryPct
    if (pct !== undefined)
      this.lastGoodBattery = pct
    return this.lastGoodBattery ?? 100
  }

  getChargingState(): CharacteristicValue {
    return this.platform.Characteristic.ChargingState.NOT_CHARGEABLE
  }

  /**
   * 20% mirrors the threshold this plugin already used before this fix (and iOS's own
   * "Low Battery" notification threshold) — low enough to avoid nuisance alerts on a coin-cell
   * sensor's normal discharge curve, high enough to leave time to notice and replace it.
   */
  getLowBatteryStatus(): CharacteristicValue {
    return (this.getBatteryLevel() as number) < 20
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
  }

  /**
   * StatusActive on the TemperatureSensor/HumiditySensor: false only when the sensor is
   * positively known to be disconnected (wireless Peripherals ConnectionState, or wired bus
   * Sensors Detected). Unknown/unresolvable defaults to active — there's no positive signal
   * of a problem, so no fault should be shown.
   */
  getSensorActive(): CharacteristicValue {
    return resolveZoneSensor(this.platform.state, this.zoneIndex).connected ?? true
  }

  async setEnableState(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    assertCommandSuccess(this.platform, await this.platform.commands.run(value ? NeoCommand.ZONE_ENABLE : NeoCommand.ZONE_DISABLE, { zoneIndex: this.zoneIndex }))
    this.platform.log.debug(`Set Zone ${this.zoneName()} Enable State -> `, value)
  }

  getEnableState(): CharacteristicValue {
    return this.getEnabled() ? 1 : 0
  }

  /**
   * Filtered through the same plausibility check that gates the service itself — in
   * `zonesAsHeaterCoolers` mode CurrentTemperature is registered unconditionally, so serving
   * the raw path would push the cloud's 3000 sentinel into a characteristic HAP caps at 100
   * and log "supplied illegal value" every update. Last-known-good, as in outdoorTemp.ts.
   */
  getCurrentTemperature(): CharacteristicValue {
    const temp = getUsableZoneTemp(this.platform.state, this.zoneIndex)
    if (temp !== undefined)
      this.lastGoodTemp = temp
    // ponytail: 0 only until a first real reading arrives; throwing (as the standalone
    // outdoor sensor does) would mark the whole zone accessory unresponsive instead.
    return this.lastGoodTemp ?? 0
  }

  getCurrentHumidity(): CharacteristicValue {
    const humidity = getUsableZoneHumidity(this.platform.state, this.zoneIndex)
    if (humidity !== undefined)
      this.lastGoodHumidity = humidity
    return this.lastGoodHumidity ?? 0
  }

  // HeaterCooler-specific methods — zones follow the master unit and cannot set its mode.
  async setActiveState(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    const enable = value === this.platform.Characteristic.Active.ACTIVE
    assertCommandSuccess(this.platform, await this.platform.commands.run(enable ? NeoCommand.ZONE_ENABLE : NeoCommand.ZONE_DISABLE, { zoneIndex: this.zoneIndex }))
    this.platform.log.debug(`Set Zone ${this.zoneName()} Active State -> `, value)
  }

  getActiveState(): CharacteristicValue {
    // If the master unit is off, every zone reads inactive regardless of its own flag.
    if (!this.platform.state.get<boolean>('UserAirconSettings.isOn'))
      return this.platform.Characteristic.Active.INACTIVE
    return this.getEnabled()
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE
  }

  getCurrentHeaterCoolerState(): CharacteristicValue {
    if (this.getActiveState() === this.platform.Characteristic.Active.INACTIVE)
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE

    const compressorMode = this.platform.state.get<string>('LiveAircon.CompressorMode')
    let currentState: number
    switch (compressorMode) {
      case CompressorMode.HEAT:
        currentState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING
        break
      case CompressorMode.COOL:
        currentState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING
        break
      default:
        currentState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE
    }

    if (!this.platform.state.get<boolean>('LiveAircon.AmRunningFan'))
      currentState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE

    return currentState
  }

  getTargetHeaterCoolerState(): CharacteristicValue {
    const climateMode = this.platform.state.get<string>('UserAirconSettings.Mode')
    switch (climateMode) {
      case ClimateMode.HEAT:
        return this.platform.Characteristic.TargetHeaterCoolerState.HEAT
      case ClimateMode.COOL:
        return this.platform.Characteristic.TargetHeaterCoolerState.COOL
      default:
        return this.platform.Characteristic.TargetHeaterCoolerState.AUTO
    }
  }

  getHeatingThresholdTemperature(): CharacteristicValue {
    return this.platform.state.get<number>(this.paths.heatSetpoint) ?? 0
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    const target = await this.resolveZoneSetpoint(
      value as number,
      'UserAirconSettings.TemperatureSetpoint_Heat_oC',
      NeoCommand.HEAT_SET_POINT,
      this.heatBounds(),
      limits => [limits.VarianceBelowMasterHeat, limits.VarianceAboveMasterHeat],
    )
    assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.ZONE_HEAT_SET_POINT, { heatTemp: target, zoneIndex: this.zoneIndex }))
    this.platform.log.debug(`Set Zone ${this.zoneName()} Heating Temperature -> `, target)
  }

  getCoolingThresholdTemperature(): CharacteristicValue {
    return this.platform.state.get<number>(this.paths.coolSetpoint) ?? 0
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.checkHvacComms()
    const target = await this.resolveZoneSetpoint(
      value as number,
      'UserAirconSettings.TemperatureSetpoint_Cool_oC',
      NeoCommand.COOL_SET_POINT,
      this.coolBounds(),
      limits => [limits.VarianceBelowMasterCool, limits.VarianceAboveMasterCool],
    )
    assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: target, zoneIndex: this.zoneIndex }))
    this.platform.log.debug(`Set Zone ${this.zoneName()} Cooling Temperature -> `, target)
  }

  private limits(): UserSetpointLimits | undefined {
    return getUserSetpointLimits(this.platform.state)
  }

  /** Never trust the per-zone Min/MaxSetpoint fields to be present — most firmwares omit them. */
  private heatBounds(): { min: number, max: number } {
    return resolveSetpointBounds(this.platform.state, 'heat', this.zoneIndex)
  }

  private coolBounds(): { min: number, max: number } {
    return resolveSetpointBounds(this.platform.state, 'cool', this.zoneIndex)
  }

  /**
   * Absolute clamp to the device's reported bounds always applies. On top of that, the Neo
   * system may report a variance band around the master's setpoint for the same mode — but
   * only a *non-zero* variance is a real constraint; 0 (or the field being absent) means the
   * device does not restrict zones relative to the master at all. A violated non-zero variance
   * nudges the master so the requested zone value can apply.
   */
  private async resolveZoneSetpoint(
    value: number,
    masterPath: string,
    masterCommand: NeoCommand.HEAT_SET_POINT | NeoCommand.COOL_SET_POINT,
    bounds: { min: number, max: number },
    variance: (limits: UserSetpointLimits) => [below: number | undefined, above: number | undefined],
  ): Promise<number> {
    const target = Math.min(Math.max(value, bounds.min), bounds.max)

    const limits = this.limits()
    const [below = 0, above = 0] = limits ? variance(limits) : []
    if (below <= 0 && above <= 0)
      return target

    const master = this.platform.state.get<number>(masterPath)
    if (master === undefined)
      return target

    const min = master - below
    const max = master + above
    if (target >= min && target <= max)
      return target

    const field = masterCommand === NeoCommand.HEAT_SET_POINT ? 'heatTemp' : 'coolTemp'
    // Nudge the master just far enough that its variance band re-includes the requested zone
    // value — not to the zone value itself, which would only coincidentally satisfy the band
    // (or, if the band is offset, still leave the zone value outside it).
    const nudgedMaster = target < min ? target + below : target - above
    // A failed nudge means the zone value can't legally apply — surface it like every other
    // command site rather than returning the value as if it had been adopted.
    assertCommandSuccess(this.platform, await this.platform.commands.run(masterCommand, { [field]: nudgedMaster }))
    return target
  }
}

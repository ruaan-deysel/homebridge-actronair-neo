import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'
import type { ActronAirNeoPlatform } from '../platform.js'
import { HAPStatus } from 'homebridge'
import { getUsableOutdoorTemp } from '../neo/capabilities.js'

/** Paths this accessory's characteristic depends on. */
const WATCHED = {
  outdoorTemp: 'MasterInfo.LiveOutdoorTemp_oC',
  sensErr: 'LiveAircon.OutdoorUnit.AmbientSensErr',
} as const

export class OutdoorTempAccessory {
  private readonly service: Service
  /**
   * Last valid reading, served when the cloud momentarily reports an unusable one — stale
   * but real beats a fabricated 0°C. Undefined only until the first valid reading arrives.
   */
  private lastGood: number | undefined

  constructor(
    private readonly platform: ActronAirNeoPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Actron')
      .setCharacteristic(this.platform.Characteristic.Model, this.platform.capabilities?.model ?? 'ActronAir Neo Outdoor Temperature')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.platform.serial)

    this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor)

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName)

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))

    // Single poll loop lives on the platform; no timer here.
    this.platform.state.onChange((changed) => {
      if (changed.has('*') || changed.has(WATCHED.outdoorTemp) || changed.has(WATCHED.sensErr))
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature())
    })
  }

  getCurrentTemperature(): CharacteristicValue {
    const temp = getUsableOutdoorTemp(this.platform.state)
    if (temp !== undefined) {
      this.lastGood = temp
      return temp
    }
    if (this.lastGood !== undefined)
      return this.lastGood

    // Never had a valid reading — there is no honest value to report, fabricating one
    // (e.g. 0°C) would be worse than surfacing the failure.
    throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  }
}

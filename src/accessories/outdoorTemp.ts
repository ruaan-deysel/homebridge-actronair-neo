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

    // Seeded from state rather than left to the first read. lastGood used to be populated only
    // when something actually read the characteristic, so a reading that went bad before HomeKit
    // ever asked made the accessory throw SERVICE_COMMUNICATION_FAILURE despite a perfectly good
    // value having been in state moments earlier.
    this.lastGood = getUsableOutdoorTemp(this.platform.state)

    this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor)

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName)

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))

    // Without these the tile shows the last-known reading indefinitely with nothing to say it
    // has gone stale — the same signal zone sensors already carry. StatusFault is the honest
    // home for AmbientSensErr specifically: the unit is telling us its ambient sensor is
    // faulty, which is exactly what the characteristic means (a system-wide ErrCode would not
    // be, which is why it isn't reported here).
    this.service.getCharacteristic(this.platform.Characteristic.StatusActive)
      .onGet(() => getUsableOutdoorTemp(this.platform.state) !== undefined)
    this.service.getCharacteristic(this.platform.Characteristic.StatusFault)
      .onGet(this.getStatusFault.bind(this))

    // Single poll loop lives on the platform; no timer here.
    this.platform.state.onChange((changed) => {
      if (changed.has('*') || changed.has(WATCHED.outdoorTemp) || changed.has(WATCHED.sensErr)) {
        // Status first, deliberately: getCurrentTemperature() throws when there has never been a
        // usable reading, and NeoState swallows a throwing listener — pushing the temperature
        // first would drop the very characteristics that explain why it failed.
        this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, getUsableOutdoorTemp(this.platform.state) !== undefined)
        this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, this.getStatusFault())
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature())
      }
    })
  }

  getStatusFault(): CharacteristicValue {
    const { NO_FAULT, GENERAL_FAULT } = this.platform.Characteristic.StatusFault
    return this.platform.state.get<boolean>(WATCHED.sensErr) === true ? GENERAL_FAULT : NO_FAULT
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

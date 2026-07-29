import type { CharacteristicValue, PlatformAccessory } from 'homebridge'
import type { ActronAirNeoPlatform } from '../platform.js'
import { HAPStatus } from 'homebridge'
import { NeoCommand } from '../neo/types.js'
import { assertCommandSuccess } from './assertCommandResult.js'

const ENABLED_PATH = 'UserAirconSettings.AfterHours.Enabled'
const DURATION_PATH = 'UserAirconSettings.AfterHours.Duration'

const MIN_DURATION_MIN = 30
const MAX_DURATION_MIN = 480
const STEP_DURATION_MIN = 30
const DEFAULT_DURATION_MIN = 120

const SECONDS_PER_MINUTE = 60
const MIN_DURATION_SEC = MIN_DURATION_MIN * SECONDS_PER_MINUTE
const MAX_DURATION_SEC = MAX_DURATION_MIN * SECONDS_PER_MINUTE
const STEP_DURATION_SEC = STEP_DURATION_MIN * SECONDS_PER_MINUTE

/**
 * After Hours is a boolean flag plus a duration (minutes on the wire) — unlike
 * away/quiet/continuousFan, which are all a single boolean, so it doesn't fit
 * ModeSwitchAccessory's shape without bolting a second characteristic onto a generic
 * that's otherwise clean. A sibling accessory keeps that generic simple and keeps this
 * one's Valve-specific bits (ValveType, InUse, the minutes<->seconds conversion) out of it.
 *
 * HomeKit has no native "duration in minutes" characteristic. Of the options:
 *   - RotationSpeed (0-100%) would force a lossy mapping of 30-480 minutes onto a percentage
 *     and read as a fan speed in the Home app — actively misleading.
 *   - Valve's SetDuration is UINT32 SECONDS by HAP definition (default props confirmed via
 *     hap-nodejs: format uint32, unit seconds, minValue 0, maxValue 3600). We conform to that
 *     rather than fight it: props are set to the device's minute range converted to seconds
 *     (1800-28800s, step 1800s) and the accessory converts at this presentation boundary only
 *     — ×60 on read, ÷60 (rounded) on write. Every device value (30-480 in steps of 30) maps
 *     to an exact integer number of seconds and back, so the conversion is lossless; the wire
 *     path (UserAirconSettings.AfterHours.Duration) and every other Actron client still only
 *     ever see minutes. hap-nodejs accepts maxValue: 28800 via setProps with no warning at
 *     registration (verified directly against the default SetDuration characteristic).
 *   - Active doubles as the on/off switch (After Hours enabled), since Valve's Active/InUse
 *     pairing is the natural "on for a bounded duration" HomeKit primitive. InUse mirrors
 *     Active because Actron doesn't report a live remaining-time countdown, only the
 *     configured duration.
 */
export class AfterHoursAccessory {
  constructor(
    private readonly platform: ActronAirNeoPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Actron')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.platform.capabilities?.model ?? 'ActronAir Neo'} After Hours`)

    const service = this.accessory.getService(this.platform.Service.Valve)
      ?? this.accessory.addService(this.platform.Service.Valve)

    service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName)
    service.setCharacteristic(this.platform.Characteristic.ValveType, 0 /* GENERIC_VALVE */)

    service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet(value => this.setActive(value))

    service.getCharacteristic(this.platform.Characteristic.InUse)
      .onGet(() => this.getActive())

    service.getCharacteristic(this.platform.Characteristic.SetDuration)
      .setProps({ minValue: MIN_DURATION_SEC, maxValue: MAX_DURATION_SEC, minStep: STEP_DURATION_SEC })
      .onGet(() => this.getDuration())
      .onSet(value => this.setDuration(value))

    this.platform.state.onChange((changed) => {
      if (changed.has('*') || changed.has(ENABLED_PATH)) {
        service.updateCharacteristic(this.platform.Characteristic.Active, this.getActive())
        service.updateCharacteristic(this.platform.Characteristic.InUse, this.getActive())
      }
      if (changed.has('*') || changed.has(DURATION_PATH))
        service.updateCharacteristic(this.platform.Characteristic.SetDuration, this.getDuration())
    })
  }

  getActive(): CharacteristicValue {
    return this.platform.state.get<boolean>(ENABLED_PATH) ? 1 : 0
  }

  getDuration(): CharacteristicValue {
    const minutes = this.platform.state.get<number>(DURATION_PATH) ?? DEFAULT_DURATION_MIN
    const clamped = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, minutes))
    return clamped * SECONDS_PER_MINUTE
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    if (!this.platform.state.cloudConnected)
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)

    const on = !!value
    assertCommandSuccess(this.platform, await this.platform.commands.run(on ? NeoCommand.AFTER_HOURS_ON : NeoCommand.AFTER_HOURS_OFF))
    this.platform.log.debug(`Set after-hours mode -> ${on}`)
  }

  async setDuration(value: CharacteristicValue): Promise<void> {
    if (!this.platform.state.cloudConnected)
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)

    const minutes = Math.round((value as number) / SECONDS_PER_MINUTE)
    const duration = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, minutes))
    assertCommandSuccess(this.platform, await this.platform.commands.run(NeoCommand.AFTER_HOURS_DURATION, { duration }))
    this.platform.log.debug(`Set after-hours duration -> ${duration}`)
  }
}

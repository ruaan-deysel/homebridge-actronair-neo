import type { CharacteristicValue, PlatformAccessory } from 'homebridge'
import type { ActronAirNeoPlatform } from '../platform.js'
import { HAPStatus } from 'homebridge'
import { NeoCommand } from '../neo/types.js'
import { assertCommandSuccess } from './assertCommandResult.js'

export type ModeSwitchMode = 'away' | 'quiet' | 'continuousFan' | 'turbo'

const READ_PATH: Record<ModeSwitchMode, string> = {
  away: 'UserAirconSettings.AwayMode',
  quiet: 'UserAirconSettings.QuietMode',
  continuousFan: 'UserAirconSettings.FanMode',
  turbo: 'UserAirconSettings.TurboMode.Enabled',
}

const ON_COMMAND: Record<'away' | 'quiet' | 'turbo', NeoCommand> = {
  away: NeoCommand.AWAY_MODE_ON,
  quiet: NeoCommand.QUIET_MODE_ON,
  turbo: NeoCommand.TURBO_MODE_ON,
}

const OFF_COMMAND: Record<'away' | 'quiet' | 'turbo', NeoCommand> = {
  away: NeoCommand.AWAY_MODE_OFF,
  quiet: NeoCommand.QUIET_MODE_OFF,
  turbo: NeoCommand.TURBO_MODE_OFF,
}

/** Speed-preserving continuous-fan commands, keyed by the current base (non-CONT) FanMode. */
const SPEED_TO_ON: Record<string, NeoCommand> = {
  AUTO: NeoCommand.FAN_MODE_AUTO_CONT,
  LOW: NeoCommand.FAN_MODE_LOW_CONT,
  MED: NeoCommand.FAN_MODE_MEDIUM_CONT,
  HIGH: NeoCommand.FAN_MODE_HIGH_CONT,
}

const SPEED_TO_OFF: Record<string, NeoCommand> = {
  AUTO: NeoCommand.FAN_MODE_AUTO,
  LOW: NeoCommand.FAN_MODE_LOW,
  MED: NeoCommand.FAN_MODE_MEDIUM,
  HIGH: NeoCommand.FAN_MODE_HIGH,
}

/**
 * Away, Quiet and Continuous-fan are all a single HomeKit switch reading and writing one
 * setting. Continuous-fan is the odd one out: there's no boolean for it on the wire, it's
 * a `+CONT` suffix on FanMode, so turning it on/off must preserve the current fan speed
 * rather than sending a fixed command.
 */
export class ModeSwitchAccessory {
  constructor(
    private readonly platform: ActronAirNeoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly mode: ModeSwitchMode,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Actron')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.platform.capabilities?.model ?? 'ActronAir Neo'} ${mode} Switch`)

    const service = this.accessory.getService(this.platform.Service.Switch)
      ?? this.accessory.addService(this.platform.Service.Switch)

    service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName)
    service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.getOn())
      .onSet(value => this.setOn(value))

    const path = READ_PATH[this.mode]
    this.platform.state.onChange((changed) => {
      if (changed.has('*') || changed.has(path))
        service.updateCharacteristic(this.platform.Characteristic.On, this.getOn())
    })
  }

  getOn(): CharacteristicValue {
    if (this.mode === 'continuousFan') {
      const fanMode = this.platform.state.get<string>(READ_PATH.continuousFan)
      return fanMode?.endsWith('+CONT') ? 1 : 0
    }
    return this.platform.state.get<boolean>(READ_PATH[this.mode]) ? 1 : 0
  }

  async setOn(value: CharacteristicValue): Promise<void> {
    if (!this.platform.state.cloudConnected)
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)

    const on = !!value
    const command = this.mode === 'continuousFan'
      ? this.continuousFanCommand(on)
      : (on ? ON_COMMAND[this.mode] : OFF_COMMAND[this.mode])
    assertCommandSuccess(this.platform, await this.platform.commands.run(command))
    this.platform.log.debug(`Set ${this.mode} mode -> ${on}`)
  }

  /** Preserves the current fan speed: MED stays MED, HIGH stays HIGH, only +CONT toggles. */
  private continuousFanCommand(on: boolean): NeoCommand {
    const fanMode = this.platform.state.get<string>(READ_PATH.continuousFan) ?? 'AUTO'
    const speed = fanMode.replace('+CONT', '')
    const table = on ? SPEED_TO_ON : SPEED_TO_OFF
    return table[speed] ?? (on ? NeoCommand.FAN_MODE_AUTO_CONT : NeoCommand.FAN_MODE_AUTO)
  }
}

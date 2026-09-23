import type { MatterAccessory } from 'homebridge'
import type { ActronAirNeoPlatform, Discovered } from '../platform.js'
import type { MatterBinding } from './types.js'
import { NeoCommand } from '../neo/types.js'
import { assertMatterCommandSuccess } from './types.js'

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

function continuousFanCommand(platform: ActronAirNeoPlatform, on: boolean): NeoCommand {
  const fanMode = platform.state.get<string>(READ_PATH.continuousFan) ?? 'AUTO'
  const speed = fanMode.replace('+CONT', '')
  const table = on ? SPEED_TO_ON : SPEED_TO_OFF
  return table[speed] ?? (on ? NeoCommand.FAN_MODE_AUTO_CONT : NeoCommand.FAN_MODE_AUTO)
}

export function buildSwitchMatterAccessory(
  platform: ActronAirNeoPlatform,
  device: Discovered,
  mode: ModeSwitchMode,
): { accessory: MatterAccessory, binding: MatterBinding } {
  const matter = platform.api.matter!
  const uuid = matter.uuid.generate(`matter:${device.id}`)
  const path = READ_PATH[mode]

  function getOn(): boolean {
    if (mode === 'continuousFan') {
      const fanMode = platform.state.get<string>(READ_PATH.continuousFan)
      return fanMode?.endsWith('+CONT') ?? false
    }
    return Boolean(platform.state.get<boolean>(path))
  }

  const accessory: MatterAccessory = {
    UUID: uuid,
    displayName: device.displayName,
    deviceType: matter.deviceTypes.OnOffSwitch,
    manufacturer: 'Actron',
    model: `${platform.capabilities?.model ?? 'ActronAir Neo'} ${mode} Switch`,
    serialNumber: `${platform.serial}-${mode}`,
    context: { device },
    clusters: {
      onOff: {
        onOff: getOn(),
      },
    },
    handlers: {
      onOff: {
        on: async () => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          const command = mode === 'continuousFan'
            ? continuousFanCommand(platform, true)
            : ON_COMMAND[mode]
          assertMatterCommandSuccess(platform, await platform.commands.run(command))
          platform.log.debug(`Matter set ${mode} switch -> On`)
        },
        off: async () => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          const command = mode === 'continuousFan'
            ? continuousFanCommand(platform, false)
            : OFF_COMMAND[mode]
          assertMatterCommandSuccess(platform, await platform.commands.run(command))
          platform.log.debug(`Matter set ${mode} switch -> Off`)
        },
      },
    },
  }

  const binding: MatterBinding = {
    uuid,
    accessory,
    update: (changed: Set<string>) => {
      if (changed.has('*') || changed.has(path)) {
        platform.api.matter?.updateAccessoryState(uuid, 'onOff', { onOff: getOn() }).catch((err) => {
          platform.log.debug(`Failed to update Matter ${mode} switch state: ${(err as Error).message}`)
        })
      }
    },
  }

  return { accessory, binding }
}

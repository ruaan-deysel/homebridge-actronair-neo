import type { MatterAccessory } from 'homebridge'
import type { ActronAirNeoPlatform, Discovered } from '../platform.js'
import type { MatterBinding } from './types.js'
import { NeoCommand } from '../neo/types.js'
import { assertMatterCommandSuccess } from './types.js'

const ENABLED_PATH = 'UserAirconSettings.AfterHours.Enabled'
const DURATION_PATH = 'UserAirconSettings.AfterHours.Duration'

const MIN_DURATION_MIN = 30
const MAX_DURATION_MIN = 480
const DEFAULT_DURATION_MIN = 120
const SECONDS_PER_MINUTE = 60

export function buildAfterHoursMatterAccessory(
  platform: ActronAirNeoPlatform,
  device: Discovered,
): { accessory: MatterAccessory, binding: MatterBinding } {
  const matter = platform.api.matter!
  const uuid = matter.uuid.generate(`matter:${device.id}`)

  function getActive(): boolean {
    return Boolean(platform.state.get<boolean>(ENABLED_PATH))
  }

  function getDurationSeconds(): number {
    const minutes = platform.state.get<number>(DURATION_PATH) ?? DEFAULT_DURATION_MIN
    const clamped = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, minutes))
    return clamped * SECONDS_PER_MINUTE
  }

  const initialActive = getActive()
  const initialDuration = getDurationSeconds()

  const accessory: MatterAccessory = {
    UUID: uuid,
    displayName: device.displayName,
    deviceType: matter.deviceTypes.WaterValve,
    manufacturer: 'Actron',
    model: `${platform.capabilities?.model ?? 'ActronAir Neo'} After Hours`,
    serialNumber: `${platform.serial}-after-hours`,
    context: { device },
    clusters: {
      valveConfigurationAndControl: {
        currentState: initialActive ? 1 : 0,
        targetState: initialActive ? 1 : 0,
        openDuration: initialDuration,
        defaultOpenDuration: DEFAULT_DURATION_MIN * SECONDS_PER_MINUTE,
      },
    },
    handlers: {
      valveConfigurationAndControl: {
        open: async (args?: { openDuration?: number | null }) => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          if (args?.openDuration !== null && args?.openDuration !== undefined && args.openDuration > 0) {
            const minutes = Math.round(args.openDuration / SECONDS_PER_MINUTE)
            const duration = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, minutes))
            assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.AFTER_HOURS_DURATION, { duration }))
          }
          assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.AFTER_HOURS_ON))
          platform.log.debug(`Matter set After Hours -> On`)
        },
        close: async () => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.AFTER_HOURS_OFF))
          platform.log.debug(`Matter set After Hours -> Off`)
        },
      },
    },
  }

  const binding: MatterBinding = {
    uuid,
    accessory,
    update: (changed: Set<string>) => {
      const all = changed.has('*')
      if (all || changed.has(ENABLED_PATH) || changed.has(DURATION_PATH)) {
        const active = getActive()
        const duration = getDurationSeconds()
        platform.api.matter?.updateAccessoryState(uuid, 'valveConfigurationAndControl', {
          currentState: active ? 1 : 0,
          targetState: active ? 1 : 0,
          openDuration: duration,
        }).catch((err) => {
          platform.log.debug(`Failed to update Matter after-hours state: ${(err as Error).message}`)
        })
      }
    },
  }

  return { accessory, binding }
}

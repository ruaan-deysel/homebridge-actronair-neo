import type { MatterAccessory } from 'homebridge'
import type { ActronAirNeoPlatform } from '../platform.js'
import { CommandResult } from '../neo/types.js'

export interface MatterBinding {
  readonly uuid: string
  readonly accessory: MatterAccessory
  update: (changed: Set<string>) => void | Promise<void>
}

export const MATTER_STRING_MAX = 32

export function matterString(value: string, max = MATTER_STRING_MAX): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd()
}

export function assertMatterCommandSuccess(platform: ActronAirNeoPlatform, result: CommandResult): void {
  if (result !== CommandResult.SUCCESS) {
    if (platform.api.matter?.status?.Failure) {
      throw new platform.api.matter.status.Failure('Command failed to apply to ActronAir system')
    }
    throw new Error('Command failed to apply to ActronAir system')
  }
}

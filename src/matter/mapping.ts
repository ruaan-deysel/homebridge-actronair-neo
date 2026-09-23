import type { MatterAccessory } from 'homebridge'
import type { ActronAirNeoPlatform, Discovered } from '../platform.js'
import type { MatterBinding } from './types.js'
import { buildMasterMatterAccessory } from './master.js'
import { buildOutdoorTempMatterAccessory } from './sensors.js'
import { buildSwitchMatterAccessory } from './switches.js'
import { buildAfterHoursMatterAccessory } from './valve.js'
import { buildZoneMatterAccessory } from './zone.js'

export function buildMatterAccessory(
  platform: ActronAirNeoPlatform,
  device: Discovered,
): { accessory: MatterAccessory, binding: MatterBinding } {
  switch (device.kind) {
    case 'master':
      return buildMasterMatterAccessory(platform, device)
    case 'zone':
      return buildZoneMatterAccessory(platform, device)
    case 'away':
    case 'quiet':
    case 'continuousFan':
    case 'turbo':
      return buildSwitchMatterAccessory(platform, device, device.kind)
    case 'outdoorTemp':
      return buildOutdoorTempMatterAccessory(platform, device)
    case 'afterHours':
      return buildAfterHoursMatterAccessory(platform, device)
    default:
      throw new Error(`Unsupported Matter device kind: ${(device as { kind: string }).kind}`)
  }
}

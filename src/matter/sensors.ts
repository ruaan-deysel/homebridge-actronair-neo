import type { MatterAccessory } from 'homebridge'
import type { ActronAirNeoPlatform, Discovered } from '../platform.js'
import type { MatterBinding } from './types.js'
import { getUsableOutdoorTemp } from '../neo/capabilities.js'
import { matterString } from './types.js'

export function buildOutdoorTempMatterAccessory(
  platform: ActronAirNeoPlatform,
  device: Discovered,
): { accessory: MatterAccessory, binding: MatterBinding } {
  const matter = platform.api.matter!
  const uuid = matter.uuid.generate(`matter:${device.id}`)

  const initialTemp = getUsableOutdoorTemp(platform.state)

  const accessory: MatterAccessory = {
    UUID: uuid,
    displayName: matterString(device.displayName),
    deviceType: matter.deviceTypes.TemperatureSensor,
    manufacturer: 'Actron',
    model: matterString(platform.capabilities?.model ?? 'ActronAir Neo Outdoor Temperature'),
    serialNumber: `${platform.serial}-outdoor`,
    context: { device },
    clusters: {
      temperatureMeasurement: {
        measuredValue: initialTemp !== undefined ? Math.round(initialTemp * 100) : null,
      },
    },
  }

  const binding: MatterBinding = {
    uuid,
    accessory,
    update: (changed: Set<string>) => {
      const all = changed.has('*')
      if (all || changed.has('MasterInfo.LiveOutdoorTemp_oC') || changed.has('LiveAircon.OutdoorUnit.AmbientSensErr')) {
        const temp = getUsableOutdoorTemp(platform.state)
        platform.api.matter?.updateAccessoryState(uuid, 'temperatureMeasurement', {
          measuredValue: temp !== undefined ? Math.round(temp * 100) : null,
        }).catch((err) => {
          platform.log.debug(`Failed to update Matter outdoor temperature state: ${(err as Error).message}`)
        })
      }
    },
  }

  return { accessory, binding }
}

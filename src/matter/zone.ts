import type { MatterAccessory } from 'homebridge'
import type { UserSetpointLimits } from '../neo/capabilities.js'
import type { ActronAirNeoPlatform, Discovered } from '../platform.js'
import type { MatterBinding } from './types.js'
import { getUsableZoneHumidity, getUsableZoneTemp, getUserSetpointLimits, resolveSetpointBounds } from '../neo/capabilities.js'
import { resolveZoneSensor } from '../neo/sensors.js'
import { ClimateMode, NeoCommand } from '../neo/types.js'
import { assertMatterCommandSuccess, matterString } from './types.js'

type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number]

enum MatterSystemMode {
  Off = 0,
  Auto = 1,
  Cool = 3,
  Heat = 4,
}

async function resolveZoneSetpoint(
  platform: ActronAirNeoPlatform,
  value: number,
  masterPath: string,
  masterCommand: NeoCommand.HEAT_SET_POINT | NeoCommand.COOL_SET_POINT,
  bounds: { min: number, max: number },
  variance: (limits: UserSetpointLimits) => [below: number | undefined, above: number | undefined],
): Promise<number> {
  const target = Math.min(Math.max(value, bounds.min), bounds.max)
  const limits = getUserSetpointLimits(platform.state)
  const [below = 0, above = 0] = limits ? variance(limits) : []
  if (below <= 0 && above <= 0)
    return target

  const master = platform.state.get<number>(masterPath)
  if (master === undefined)
    return target

  const min = master - below
  const max = master + above
  if (target >= min && target <= max)
    return target

  const field = masterCommand === NeoCommand.HEAT_SET_POINT ? 'heatTemp' : 'coolTemp'
  const nudgedMaster = target < min ? target + below : target - above
  assertMatterCommandSuccess(platform, await platform.commands.run(masterCommand, { [field]: nudgedMaster }))
  return target
}

export function buildZoneMatterAccessory(
  platform: ActronAirNeoPlatform,
  device: Discovered,
): { accessory: MatterAccessory, binding: MatterBinding } {
  const matter = platform.api.matter!
  const zi = device.zoneIndex!
  const uuid = matter.uuid.generate(`matter:${device.id}`)

  const heatBounds = resolveSetpointBounds(platform.state, 'heat', zi)
  const coolBounds = resolveSetpointBounds(platform.state, 'cool', zi)

  const paths = {
    coolSetpoint: `RemoteZoneInfo[${zi}].TemperatureSetpoint_Cool_oC`,
    heatSetpoint: `RemoteZoneInfo[${zi}].TemperatureSetpoint_Heat_oC`,
    zonePosition: `RemoteZoneInfo[${zi}].ZonePosition`,
  }

  function getZoneEnabled(): boolean {
    const isMasterOn = platform.state.get<boolean>('UserAirconSettings.isOn')
    if (!isMasterOn)
      return false
    const enabledZones = platform.state.get<boolean[]>('UserAirconSettings.EnabledZones')
    if (enabledZones && enabledZones[zi] !== undefined)
      return enabledZones[zi]
    const pos = platform.state.get<number>(paths.zonePosition)
    return pos !== undefined ? pos > 0 : false
  }

  function getZoneSystemMode(): MatterSystemMode {
    if (!getZoneEnabled())
      return MatterSystemMode.Off

    const mode = platform.state.get<string>('UserAirconSettings.Mode')
    switch (mode) {
      case ClimateMode.HEAT:
        return MatterSystemMode.Heat
      case ClimateMode.COOL:
        return MatterSystemMode.Cool
      case ClimateMode.AUTO:
      default:
        return MatterSystemMode.Auto
    }
  }

  function getBatteryState(): { batPercentRemaining: number, batChargeLevel: number } | undefined {
    const sensorInfo = resolveZoneSensor(platform.state, zi)
    if (sensorInfo.kind === 'wireless' && sensorInfo.batteryPct !== undefined) {
      const pct = Math.min(100, Math.max(0, sensorInfo.batteryPct))
      return {
        batPercentRemaining: Math.round(pct * 2), // 0-200 in Matter
        batChargeLevel: pct < 15 ? 2 : pct < 30 ? 1 : 0, // 0=Ok, 1=Warning, 2=Critical
      }
    }
    return undefined
  }

  const liveTemp = getUsableZoneTemp(platform.state, zi)
  const initialTemp = liveTemp !== undefined ? Math.round(liveTemp * 100) : 2100
  const initialHeat = Math.round((platform.state.get<number>(paths.heatSetpoint) ?? 20) * 100)
  const initialCool = Math.round((platform.state.get<number>(paths.coolSetpoint) ?? 24) * 100)
  const batteryState = getBatteryState()

  let accessory: MatterAccessory

  if (platform.cfg.zonesAsHeaterCoolers) {
    const clusters: Record<string, Record<string, unknown>> = {
      thermostat: {
        systemMode: getZoneSystemMode(),
        occupiedHeatingSetpoint: initialHeat,
        occupiedCoolingSetpoint: initialCool,
        localTemperature: initialTemp,
        minHeatSetpointLimit: heatBounds.min * 100,
        maxHeatSetpointLimit: heatBounds.max * 100,
        minCoolSetpointLimit: coolBounds.min * 100,
        maxCoolSetpointLimit: coolBounds.max * 100,
        absMinHeatSetpointLimit: 700,
        absMaxHeatSetpointLimit: 3000,
        absMinCoolSetpointLimit: 1600,
        absMaxCoolSetpointLimit: 3200,
        minSetpointDeadBand: 20,
        controlSequenceOfOperation: 4,
      },
    }

    if (batteryState) {
      clusters.powerSource = batteryState
    }

    accessory = {
      UUID: uuid,
      displayName: matterString(device.displayName),
      deviceType: matter.deviceTypes.Thermostat,
      manufacturer: 'Actron',
      model: matterString(`${platform.capabilities?.model ?? 'ActronAir Neo'} Zone`),
      serialNumber: `${platform.serial}-zone-${zi}`,
      context: { device },
      clusters,
      handlers: {
        thermostat: {
          systemModeChange: async ({ systemMode }: { systemMode: number }) => {
            if (!platform.state.cloudConnected) {
              throw new Error('ActronAir Master Controller is offline')
            }
            const enable = systemMode !== MatterSystemMode.Off
            assertMatterCommandSuccess(
              platform,
              await platform.commands.run(enable ? NeoCommand.ZONE_ENABLE : NeoCommand.ZONE_DISABLE, { zoneIndex: zi }),
            )
            platform.log.debug(`Matter set Zone ${zi} (${device.displayName}) mode -> ${systemMode} (enable: ${enable})`)
            platform.api.matter?.updateAccessoryState(uuid, 'thermostat', { systemMode: getZoneSystemMode() }).catch((err) => {
              platform.log.debug(`Failed to reconcile Matter zone ${zi} systemMode: ${(err as Error).message}`)
            })
          },
          occupiedHeatingSetpointChange: async ({ occupiedHeatingSetpoint }: { occupiedHeatingSetpoint: number }) => {
            if (!platform.state.cloudConnected) {
              throw new Error('ActronAir Master Controller is offline')
            }
            const requested = occupiedHeatingSetpoint / 100
            const target = await resolveZoneSetpoint(
              platform,
              requested,
              'UserAirconSettings.TemperatureSetpoint_Heat_oC',
              NeoCommand.HEAT_SET_POINT,
              heatBounds,
              limits => [limits.VarianceBelowMasterHeat, limits.VarianceAboveMasterHeat],
            )
            assertMatterCommandSuccess(
              platform,
              await platform.commands.run(NeoCommand.ZONE_HEAT_SET_POINT, { heatTemp: target, zoneIndex: zi }),
            )
            platform.log.debug(`Matter set Zone ${zi} Heating Setpoint -> ${target}`)
          },
          occupiedCoolingSetpointChange: async ({ occupiedCoolingSetpoint }: { occupiedCoolingSetpoint: number }) => {
            if (!platform.state.cloudConnected) {
              throw new Error('ActronAir Master Controller is offline')
            }
            const requested = occupiedCoolingSetpoint / 100
            const target = await resolveZoneSetpoint(
              platform,
              requested,
              'UserAirconSettings.TemperatureSetpoint_Cool_oC',
              NeoCommand.COOL_SET_POINT,
              coolBounds,
              limits => [limits.VarianceBelowMasterCool, limits.VarianceAboveMasterCool],
            )
            assertMatterCommandSuccess(
              platform,
              await platform.commands.run(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: target, zoneIndex: zi }),
            )
            platform.log.debug(`Matter set Zone ${zi} Cooling Setpoint -> ${target}`)
          },
        },
      },
    }
  }
  else {
    // Switch mode
    const clusters: Record<string, Record<string, unknown>> = {
      onOff: {
        onOff: getZoneEnabled(),
      },
    }

    if (batteryState) {
      clusters.powerSource = batteryState
    }

    const parts: MatterAccessoryPart[] = []

    if (liveTemp !== undefined) {
      parts.push({
        id: 'temperature',
        displayName: matterString(`${device.displayName} Temperature`),
        deviceType: matter.deviceTypes.TemperatureSensor,
        clusters: {
          temperatureMeasurement: {
            measuredValue: Math.round(liveTemp * 100),
          },
        },
      })
    }

    const liveHumidity = getUsableZoneHumidity(platform.state, zi)
    if (liveHumidity !== undefined) {
      parts.push({
        id: 'humidity',
        displayName: matterString(`${device.displayName} Humidity`),
        deviceType: matter.deviceTypes.HumiditySensor,
        clusters: {
          relativeHumidityMeasurement: {
            measuredValue: Math.round(liveHumidity * 100),
          },
        },
      })
    }

    accessory = {
      UUID: uuid,
      displayName: matterString(device.displayName),
      deviceType: matter.deviceTypes.OnOffSwitch,
      manufacturer: 'Actron',
      model: matterString(`${platform.capabilities?.model ?? 'ActronAir Neo'} Zone`),
      serialNumber: `${platform.serial}-zone-${zi}`,
      context: { device },
      clusters,
      handlers: {
        onOff: {
          on: async () => {
            if (!platform.state.cloudConnected) {
              throw new Error('ActronAir Master Controller is offline')
            }
            assertMatterCommandSuccess(
              platform,
              await platform.commands.run(NeoCommand.ZONE_ENABLE, { zoneIndex: zi }),
            )
            platform.log.debug(`Matter set Zone ${zi} (${device.displayName}) -> On`)
          },
          off: async () => {
            if (!platform.state.cloudConnected) {
              throw new Error('ActronAir Master Controller is offline')
            }
            assertMatterCommandSuccess(
              platform,
              await platform.commands.run(NeoCommand.ZONE_DISABLE, { zoneIndex: zi }),
            )
            platform.log.debug(`Matter set Zone ${zi} (${device.displayName}) -> Off`)
          },
        },
      },
      parts,
    }
  }

  const binding: MatterBinding = {
    uuid,
    accessory,
    update: (changed: Set<string>) => {
      const all = changed.has('*')
      const prefix = `RemoteZoneInfo[${zi}]`
      const enabledChanged = all || [...changed].some(p => p.startsWith('UserAirconSettings.EnabledZones'))
      const masterChanged = changed.has('UserAirconSettings.isOn') || changed.has('UserAirconSettings.Mode')
      const sensorChanged = [...changed].some(p => p.startsWith('AirconSystem.Peripherals') || p.startsWith('AirconSystem.Sensors'))
      const zoneChanged = [...changed].some(p => p.startsWith(prefix))

      if (!all && !enabledChanged && !masterChanged && !sensorChanged && !zoneChanged)
        return

      if (platform.cfg.zonesAsHeaterCoolers) {
        const update: Record<string, unknown> = {}
        if (all || enabledChanged || masterChanged || zoneChanged) {
          update.systemMode = getZoneSystemMode()
        }
        if (all || changed.has(paths.heatSetpoint)) {
          const heat = platform.state.get<number>(paths.heatSetpoint)
          if (heat !== undefined)
            update.occupiedHeatingSetpoint = Math.round(heat * 100)
        }
        if (all || changed.has(paths.coolSetpoint)) {
          const cool = platform.state.get<number>(paths.coolSetpoint)
          if (cool !== undefined)
            update.occupiedCoolingSetpoint = Math.round(cool * 100)
        }
        if (all || sensorChanged || zoneChanged) {
          const currentTemp = getUsableZoneTemp(platform.state, zi)
          update.localTemperature = currentTemp !== undefined ? Math.round(currentTemp * 100) : null
        }

        if (Object.keys(update).length > 0) {
          platform.api.matter?.updateAccessoryState(uuid, 'thermostat', update).catch((err) => {
            platform.log.debug(`Failed to update Matter zone ${zi} thermostat state: ${(err as Error).message}`)
          })
        }
      }
      else {
        // Switch mode
        if (all || enabledChanged || masterChanged || zoneChanged) {
          platform.api.matter?.updateAccessoryState(uuid, 'onOff', { onOff: getZoneEnabled() }).catch((err) => {
            platform.log.debug(`Failed to update Matter zone ${zi} switch state: ${(err as Error).message}`)
          })
        }
        if (all || sensorChanged || zoneChanged) {
          const currentTemp = getUsableZoneTemp(platform.state, zi)
          platform.api.matter?.updateAccessoryState(
            uuid,
            'temperatureMeasurement',
            { measuredValue: currentTemp !== undefined ? Math.round(currentTemp * 100) : null },
            'temperature',
          ).catch((err) => {
            platform.log.debug(`Failed to update Matter zone ${zi} temperature: ${(err as Error).message}`)
          })
          const currentHum = getUsableZoneHumidity(platform.state, zi)
          platform.api.matter?.updateAccessoryState(
            uuid,
            'relativeHumidityMeasurement',
            { measuredValue: currentHum !== undefined ? Math.round(currentHum * 100) : null },
            'humidity',
          ).catch((err) => {
            platform.log.debug(`Failed to update Matter zone ${zi} humidity: ${(err as Error).message}`)
          })
        }
      }

      if (all || sensorChanged) {
        const bat = getBatteryState()
        if (bat) {
          platform.api.matter?.updateAccessoryState(uuid, 'powerSource', bat).catch((err) => {
            platform.log.debug(`Failed to update Matter zone ${zi} powerSource state: ${(err as Error).message}`)
          })
        }
      }
    },
  }

  return { accessory, binding }
}

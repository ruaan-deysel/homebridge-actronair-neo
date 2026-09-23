import type { MatterAccessory } from 'homebridge'
import type { ActronAirNeoPlatform, Discovered } from '../platform.js'
import type { MatterBinding } from './types.js'
import { getUsableMasterHumidity, getUsableMasterTemp, resolveSetpointBounds } from '../neo/capabilities.js'
import { ClimateMode, FanMode, NeoCommand } from '../neo/types.js'
import { assertMatterCommandSuccess, matterString } from './types.js'

type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number]

/**
 * Matter Thermostat SystemMode enum values:
 * 0 = Off, 1 = Auto, 3 = Cool, 4 = Heat, 7 = FanOnly
 */
enum MatterSystemMode {
  Off = 0,
  Auto = 1,
  Cool = 3,
  Heat = 4,
  FanOnly = 7,
}

/**
 * Matter FanControl FanMode enum values:
 * 0 = Off, 1 = Low, 2 = Medium, 3 = High, 5 = Auto
 */
enum MatterFanMode {
  Off = 0,
  Low = 1,
  Medium = 2,
  High = 3,
  Auto = 5,
}
function resolveFanModeSequence(speeds: FanMode[]): number {
  const hasAuto = speeds.includes(FanMode.AUTO)
  const hasMed = speeds.includes(FanMode.MEDIUM)
  if (hasAuto) {
    return hasMed ? 2 /* OffLowMedHighAuto */ : 3 /* OffLowHighAuto */
  }
  return hasMed ? 0 /* OffLowMedHigh */ : 1 /* OffLowHigh */
}

function fanSpeedCommand(platform: ActronAirNeoPlatform, speed: 'LOW' | 'MED' | 'HIGH' | 'AUTO'): NeoCommand {
  const isCont = platform.state.get<string>('UserAirconSettings.FanMode')?.endsWith('+CONT') ?? false
  const table = {
    LOW: [NeoCommand.FAN_MODE_LOW, NeoCommand.FAN_MODE_LOW_CONT],
    MED: [NeoCommand.FAN_MODE_MEDIUM, NeoCommand.FAN_MODE_MEDIUM_CONT],
    HIGH: [NeoCommand.FAN_MODE_HIGH, NeoCommand.FAN_MODE_HIGH_CONT],
    AUTO: [NeoCommand.FAN_MODE_AUTO, NeoCommand.FAN_MODE_AUTO_CONT],
  } as const
  return table[speed][isCont ? 1 : 0]
}

export function buildMasterMatterAccessory(
  platform: ActronAirNeoPlatform,
  device: Discovered,
): { accessory: MatterAccessory, binding: MatterBinding } {
  const matter = platform.api.matter!
  const uuid = matter.uuid.generate(`matter:${device.id}`)

  const heatBounds = resolveSetpointBounds(platform.state, 'heat')
  const coolBounds = resolveSetpointBounds(platform.state, 'cool')

  function getSystemMode(): MatterSystemMode {
    const isOn = platform.state.get<boolean>('UserAirconSettings.isOn')
    if (!isOn)
      return MatterSystemMode.Off

    const mode = platform.state.get<string>('UserAirconSettings.Mode')
    switch (mode) {
      case ClimateMode.HEAT:
        return MatterSystemMode.Heat
      case ClimateMode.COOL:
        return MatterSystemMode.Cool
      case ClimateMode.AUTO:
        return MatterSystemMode.Auto
      case ClimateMode.FAN:
        return MatterSystemMode.FanOnly
      default:
        return MatterSystemMode.Off
    }
  }

  function getFanState(): { fanMode: MatterFanMode, percentSetting: number, percentCurrent: number } {
    const isOn = platform.state.get<boolean>('UserAirconSettings.isOn')
    if (!isOn) {
      return { fanMode: MatterFanMode.Off, percentSetting: 0, percentCurrent: 0 }
    }

    const rawFan = platform.state.get<string>('UserAirconSettings.FanMode')
    const speed = rawFan?.replace('+CONT', '')
    switch (speed) {
      case FanMode.LOW:
        return { fanMode: MatterFanMode.Low, percentSetting: 33, percentCurrent: 33 }
      case FanMode.MEDIUM:
        return { fanMode: MatterFanMode.Medium, percentSetting: 66, percentCurrent: 66 }
      case FanMode.HIGH:
        return { fanMode: MatterFanMode.High, percentSetting: 100, percentCurrent: 100 }
      case FanMode.AUTO:
      default:
        return { fanMode: MatterFanMode.Auto, percentSetting: 100, percentCurrent: 100 }
    }
  }

  const liveTemp = getUsableMasterTemp(platform.state)
  const initialTemp = liveTemp !== undefined ? Math.round(liveTemp * 100) : 2100
  const initialHeatSetpoint = Math.round((platform.state.get<number>('UserAirconSettings.TemperatureSetpoint_Heat_oC') ?? 20) * 100)
  const initialCoolSetpoint = Math.round((platform.state.get<number>('UserAirconSettings.TemperatureSetpoint_Cool_oC') ?? 24) * 100)

  const parts: MatterAccessoryPart[] = []

  // Fan child part
  const initialFanState = getFanState()
  parts.push({
    id: 'fan',
    displayName: matterString(`${device.displayName} Fan`),
    deviceType: matter.deviceTypes.Fan,
    clusters: {
      fanControl: {
        fanMode: initialFanState.fanMode,
        fanModeSequence: resolveFanModeSequence(platform.capabilities?.fanSpeeds ?? []),
        percentSetting: initialFanState.percentSetting,
        percentCurrent: initialFanState.percentCurrent,
        speedMax: 3,
      },
    },
    handlers: {
      fanControl: {
        fanModeChange: async ({ fanMode }: { fanMode: number }) => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          let cmd: NeoCommand
          switch (fanMode) {
            case MatterFanMode.Off:
              if (platform.state.get<string>('UserAirconSettings.Mode') !== ClimateMode.FAN) {
                throw new Error('Fan cannot be turned off independently of the system')
              }
              cmd = NeoCommand.OFF
              break
            case MatterFanMode.Low:
              cmd = fanSpeedCommand(platform, 'LOW')
              break
            case MatterFanMode.Medium:
              cmd = fanSpeedCommand(platform, 'MED')
              break
            case MatterFanMode.High:
              cmd = fanSpeedCommand(platform, 'HIGH')
              break
            case MatterFanMode.Auto:
            default:
              cmd = fanSpeedCommand(platform, 'AUTO')
              break
          }
          assertMatterCommandSuccess(platform, await platform.commands.run(cmd))
          platform.log.debug(`Matter set Master Fan Mode -> ${fanMode}`)
        },
        percentSettingChange: async ({ percentSetting }: { percentSetting: number | null }) => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          let cmd: NeoCommand
          if (percentSetting === 0) {
            if (platform.state.get<string>('UserAirconSettings.Mode') !== ClimateMode.FAN) {
              throw new Error('Fan cannot be turned off independently of the system')
            }
            cmd = NeoCommand.OFF
          }
          else if (percentSetting === null || percentSetting === undefined) {
            cmd = fanSpeedCommand(platform, 'AUTO')
          }
          else if (percentSetting <= 33) {
            cmd = fanSpeedCommand(platform, 'LOW')
          }
          else if (percentSetting <= 66) {
            cmd = fanSpeedCommand(platform, 'MED')
          }
          else {
            cmd = fanSpeedCommand(platform, 'HIGH')
          }
          assertMatterCommandSuccess(platform, await platform.commands.run(cmd))
          platform.log.debug(`Matter set Master Fan Percent -> ${percentSetting}`)
        },
      },
    },
  })

  // Humidity child part
  const liveHumidity = getUsableMasterHumidity(platform.state)
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

  const accessory: MatterAccessory = {
    UUID: uuid,
    displayName: matterString(device.displayName),
    deviceType: matter.deviceTypes.Thermostat,
    manufacturer: 'Actron',
    model: matterString(platform.capabilities?.model ?? 'ActronAir Neo Master Controller'),
    serialNumber: platform.serial,
    context: { device },
    clusters: {
      thermostat: {
        systemMode: getSystemMode(),
        occupiedHeatingSetpoint: initialHeatSetpoint,
        occupiedCoolingSetpoint: initialCoolSetpoint,
        localTemperature: initialTemp,
        minHeatSetpointLimit: heatBounds.min * 100,
        maxHeatSetpointLimit: heatBounds.max * 100,
        minCoolSetpointLimit: coolBounds.min * 100,
        maxCoolSetpointLimit: coolBounds.max * 100,
        absMinHeatSetpointLimit: 700,
        absMaxHeatSetpointLimit: 3000,
        absMinCoolSetpointLimit: 1600,
        absMaxCoolSetpointLimit: 3200,
        minSetpointDeadBand: 0,
        controlSequenceOfOperation: 4,
      },
    },
    handlers: {
      thermostat: {
        systemModeChange: async ({ systemMode }: { systemMode: number }) => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          const isOn = platform.state.get<boolean>('UserAirconSettings.isOn')
          switch (systemMode) {
            case MatterSystemMode.Off:
              assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.OFF))
              break
            case MatterSystemMode.Auto:
              if (!isOn)
                assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.ON))
              assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.CLIMATE_MODE_AUTO))
              break
            case MatterSystemMode.Cool:
              if (!isOn)
                assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.ON))
              assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.CLIMATE_MODE_COOL))
              break
            case MatterSystemMode.Heat:
              if (!isOn)
                assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.ON))
              assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.CLIMATE_MODE_HEAT))
              break
            case MatterSystemMode.FanOnly:
              assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.FAN_ONLY_ON))
              break
            default:
              platform.log.debug(`Matter unsupported systemMode: ${systemMode}`)
          }
          platform.log.debug(`Matter set Master SystemMode -> ${systemMode}`)
        },
        occupiedHeatingSetpointChange: async ({ occupiedHeatingSetpoint }: { occupiedHeatingSetpoint: number }) => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          const heatTemp = occupiedHeatingSetpoint / 100
          assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.HEAT_SET_POINT, { heatTemp }))
          platform.log.debug(`Matter set Master Heating Setpoint -> ${heatTemp}`)
        },
        occupiedCoolingSetpointChange: async ({ occupiedCoolingSetpoint }: { occupiedCoolingSetpoint: number }) => {
          if (!platform.state.cloudConnected) {
            throw new Error('ActronAir Master Controller is offline')
          }
          const coolTemp = occupiedCoolingSetpoint / 100
          assertMatterCommandSuccess(platform, await platform.commands.run(NeoCommand.COOL_SET_POINT, { coolTemp }))
          platform.log.debug(`Matter set Master Cooling Setpoint -> ${coolTemp}`)
        },
      },
    },
    parts,
  }

  const binding: MatterBinding = {
    uuid,
    accessory,
    update: (changed: Set<string>) => {
      const all = changed.has('*')
      const thermostatUpdate: Record<string, unknown> = {}

      if (all || changed.has('UserAirconSettings.isOn') || changed.has('UserAirconSettings.Mode')) {
        thermostatUpdate.systemMode = getSystemMode()
      }
      if (all || changed.has('UserAirconSettings.TemperatureSetpoint_Heat_oC')) {
        const heat = platform.state.get<number>('UserAirconSettings.TemperatureSetpoint_Heat_oC')
        if (heat !== undefined)
          thermostatUpdate.occupiedHeatingSetpoint = Math.round(heat * 100)
      }
      if (all || changed.has('UserAirconSettings.TemperatureSetpoint_Cool_oC')) {
        const cool = platform.state.get<number>('UserAirconSettings.TemperatureSetpoint_Cool_oC')
        if (cool !== undefined)
          thermostatUpdate.occupiedCoolingSetpoint = Math.round(cool * 100)
      }
      if (all || changed.has('MasterInfo.LiveTemp_oC')) {
        const temp = getUsableMasterTemp(platform.state)
        thermostatUpdate.localTemperature = temp !== undefined ? Math.round(temp * 100) : null
      }

      if (Object.keys(thermostatUpdate).length > 0) {
        platform.api.matter?.updateAccessoryState(uuid, 'thermostat', thermostatUpdate).catch((err) => {
          platform.log.debug(`Failed to update Matter master thermostat state: ${(err as Error).message}`)
        })
      }

      if (all || changed.has('UserAirconSettings.FanMode') || changed.has('UserAirconSettings.isOn')) {
        const fanUpdate = getFanState()
        platform.api.matter?.updateAccessoryState(uuid, 'fanControl', fanUpdate, 'fan').catch((err) => {
          platform.log.debug(`Failed to update Matter master fan state: ${(err as Error).message}`)
        })
      }

      if (all || changed.has('MasterInfo.LiveHumidity_pc')) {
        const hum = getUsableMasterHumidity(platform.state)
        platform.api.matter?.updateAccessoryState(
          uuid,
          'relativeHumidityMeasurement',
          { measuredValue: hum !== undefined ? Math.round(hum * 100) : null },
          'humidity',
        ).catch((err) => {
          platform.log.debug(`Failed to update Matter master humidity state: ${(err as Error).message}`)
        })
      }
    },
  }

  return { accessory, binding }
}

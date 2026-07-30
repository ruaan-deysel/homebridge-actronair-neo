import type { NeoState } from './state.js'
import { FanMode } from './types.js'

/**
 * Single source of truth for "what can this unit actually do". Every capability question in
 * the plugin is answered here — accessories read `NeoCapabilities` rather than poking at
 * `NeoState` paths directly, so a new gate never gets implemented twice and disagreeing.
 */
export interface NeoCapabilities {
  /** MasterWCModel, falling back to the indoor unit's model, falling back to a label. */
  model: string
  indoorModel?: string
  outdoorFamily?: string
  capacityKw?: number
  /** Climate modes this unit will accept — see deriveModeSupport(). */
  modes: NeoModeSupport
  /** Speeds this unit actually supports, in slider order (never empty). */
  fanSpeeds: FanMode[]
  supportsAutoFan: boolean
  supportsTurbo: boolean
  supportsVft: boolean
  quietModeAvailable: boolean
  outdoorTempUsable: boolean
}

/** The sentinel the cloud API uses for "no reading" (also seen on e.g. SuperHeat). */
const OUTDOOR_TEMP_SENTINEL = 3000

/**
 * Plausible outdoor ambient range. Strictly inside HomeKit's CurrentTemperature bounds
 * (-270..100 °C) so a passing value can never be rejected by HAP. -40°C/60°C comfortably
 * covers the coldest and hottest inhabited outdoor conditions on Earth (world extremes sit
 * around -50°C, and system OutdoorUnit ambients don't run hotter than mid-50s°C) while still
 * rejecting obvious garbage/sentinel values like 3000.
 */
const OUTDOOR_TEMP_MIN_PLAUSIBLE_C = -40
const OUTDOOR_TEMP_MAX_PLAUSIBLE_C = 60

/**
 * "Is the outdoor reading usable." Moved from accessories/outdoorTemp.ts so the platform's
 * registration gate and the accessory's getter can never disagree.
 */
export function getUsableOutdoorTemp(state: NeoState): number | undefined {
  const temp = state.get<number>('MasterInfo.LiveOutdoorTemp_oC')
  if (temp === undefined || temp === OUTDOOR_TEMP_SENTINEL)
    return undefined
  if (temp < OUTDOOR_TEMP_MIN_PLAUSIBLE_C || temp > OUTDOOR_TEMP_MAX_PLAUSIBLE_C)
    return undefined
  if (state.get<boolean>('LiveAircon.OutdoorUnit.AmbientSensErr'))
    return undefined
  return temp
}

/**
 * Plausible indoor ambient range — narrower than the outdoor bounds since a zone sensor sits
 * inside a conditioned space, not exposed to weather extremes. Also rejects the same 3000
 * sentinel the outdoor reading uses.
 */
const ZONE_TEMP_MIN_PLAUSIBLE_C = -10
const ZONE_TEMP_MAX_PLAUSIBLE_C = 50

function usableIndoorTemp(temp: number | undefined): number | undefined {
  if (temp === undefined || temp === OUTDOOR_TEMP_SENTINEL)
    return undefined
  if (temp < ZONE_TEMP_MIN_PLAUSIBLE_C || temp > ZONE_TEMP_MAX_PLAUSIBLE_C)
    return undefined
  return temp
}

/** Outside the physically possible range (which also catches the 3000 sentinel) is no reading. */
function usableHumidity(humidity: number | undefined): number | undefined {
  return humidity === undefined || humidity < 0 || humidity > 100 ? undefined : humidity
}

/**
 * "Is this zone's live temperature usable." Same shape as getUsableOutdoorTemp — a zone
 * TemperatureSensor service (and the HeaterCooler's CurrentTemperature) must never invent a
 * reading for a zone that hasn't got one.
 */
export function getUsableZoneTemp(state: NeoState, zoneIndex: number): number | undefined {
  return usableIndoorTemp(state.get<number>(`RemoteZoneInfo[${zoneIndex}].LiveTemp_oC`))
}

/**
 * "Is this zone's live humidity usable." Not every sensor model reports humidity — absence,
 * or a value outside the physically possible 0-100% range, means no HumiditySensor service
 * rather than a fabricated percentage.
 */
export function getUsableZoneHumidity(state: NeoState, zoneIndex: number): number | undefined {
  return usableHumidity(state.get<number>(`RemoteZoneInfo[${zoneIndex}].LiveHumidity_pc`))
}

/** The master controller's own sensor — same plausibility rules as a zone's. */
export function getUsableMasterTemp(state: NeoState): number | undefined {
  return usableIndoorTemp(state.get<number>('MasterInfo.LiveTemp_oC'))
}

export function getUsableMasterHumidity(state: NeoState): number | undefined {
  return usableHumidity(state.get<number>('MasterInfo.LiveHumidity_pc'))
}

/**
 * Device-reported absolute bounds and master-variance constraints for setpoints. Reported
 * once at `NV_Limits.UserSetpoint_oC` (not per-zone). Some firmwares omit it entirely, and a
 * variance of 0 means "no constraint" rather than "zero-width band".
 */
export interface UserSetpointLimits {
  setCool_Min?: number
  setCool_Max?: number
  setHeat_Min?: number
  setHeat_Max?: number
  VarianceAboveMasterCool?: number
  VarianceBelowMasterCool?: number
  VarianceAboveMasterHeat?: number
  VarianceBelowMasterHeat?: number
}

/**
 * Last-resort setpoint bounds, used only for a device that reports none of its own. These are
 * the values the removed min/max{Heating,Cooling}Temp config options defaulted to, so nothing
 * changes for such a device; anything the device does report always wins.
 */
const DEFAULT_BOUNDS = {
  heat: { min: 10, max: 26 },
  cool: { min: 20, max: 32 },
} as const

export function getUserSetpointLimits(state: NeoState): UserSetpointLimits | undefined {
  return state.get<UserSetpointLimits>('NV_Limits.UserSetpoint_oC')
}

/**
 * Setpoint bounds for the master (no zoneIndex) or a zone, resolved device-first:
 * per-zone Min/MaxSetpoint (most firmwares omit them) → the device's NV_Limits →
 * DEFAULT_BOUNDS. Shared by both accessories so HomeKit can never offer the master a range
 * the device rejects while the zones honour the real one.
 */
export function resolveSetpointBounds(
  state: NeoState,
  mode: 'heat' | 'cool',
  zoneIndex?: number,
): { min: number, max: number } {
  const fallback = DEFAULT_BOUNDS[mode]
  const limits = getUserSetpointLimits(state)
  const key = mode === 'heat' ? 'Heat' : 'Cool'
  const zone = (bound: 'Min' | 'Max'): number | undefined =>
    zoneIndex === undefined
      ? undefined
      : state.get<number>(`RemoteZoneInfo[${zoneIndex}].${bound}${key}Setpoint`)

  return {
    min: zone('Min') ?? limits?.[`set${key}_Min`] ?? fallback.min,
    max: zone('Max') ?? limits?.[`set${key}_Max`] ?? fallback.max,
  }
}

/**
 * "Is turbo usable." Moved from accessories/modeSwitch.ts so the platform's registration
 * gate and NeoCapabilities agree on the same answer.
 */
export function isTurboModeSupported(state: NeoState): boolean {
  return state.get<boolean>('UserAirconSettings.TurboMode.Supported') === true
}

/**
 * Which of the controller's climate modes this unit will accept, from
 * `UserAirconSettings.ModeSupport` — the same list the ActronAir app's Mode picker is built
 * from (the owner's NTW-1000 reports Cool/Heat/Fan/Auto true, Dry false).
 */
export interface NeoModeSupport {
  cool: boolean
  heat: boolean
  auto: boolean
  /** Fan-only. HomeKit's HeaterCooler has no target state for it — see accessories/master.ts. */
  fan: boolean
  /** Dry/dehumidify. Reported false on every unit seen so far, and not exposed yet. */
  dry: boolean
}

/**
 * ModeSupport is authoritative when the unit reports it, per field: a mode it says it hasn't
 * got is reported here as unsupported, full stop. Only an *absent* (or non-boolean) field
 * falls back, to the four modes every Neo controller has always had — dry being the one
 * genuinely optional mode, so its absence means "no" rather than being assumed.
 *
 * Deliberately no "at least one thermostat mode" clamp here. HAP does need a non-empty
 * TargetHeaterCoolerState validValues list, but that is HAP's constraint, not the device's
 * capability, and rewriting an honest all-false report into all-true here would have every
 * other consumer believe in modes the hardware rejects. MasterAccessory handles the empty
 * case at the HAP boundary where the reason lives.
 */
export function deriveModeSupport(state: NeoState): NeoModeSupport {
  const reported = state.get<Record<string, unknown>>('UserAirconSettings.ModeSupport')
  const supported = (key: string, fallback: boolean): boolean =>
    typeof reported?.[key] === 'boolean' ? reported[key] as boolean : fallback

  return {
    cool: supported('Cool', true),
    heat: supported('Heat', true),
    auto: supported('Auto', true),
    fan: supported('Fan', true),
    dry: supported('Dry', false),
  }
}

/** Bitmap bits for AirconSystem.IndoorUnit.NV_SupportedFanModes. */
const FAN_BIT: Partial<Record<FanMode, number>> = {
  [FanMode.LOW]: 1,
  [FanMode.MEDIUM]: 2,
  [FanMode.HIGH]: 4,
  [FanMode.AUTO]: 8,
}

/** Canonical slider order — AUTO always last so it can occupy the top band. */
const FAN_ORDER: readonly FanMode[] = [FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH, FanMode.AUTO]

/**
 * Decodes NV_SupportedFanModes, unions in whatever speed the unit is currently running (the
 * owner's own indoor unit runs HIGH while omitting it from the bitmap — a known firmware
 * under-report also documented by the reference HA integration), and gates AUTO on
 * NV_AutoFanEnabled. An absent/zero/unparseable bitmap degrades to [LOW, MED, HIGH] — an
 * unknown model must still get a working baseline, never zero fan speeds.
 */
function deriveFanSpeeds(state: NeoState): FanMode[] {
  const raw = state.get<number>('AirconSystem.IndoorUnit.NV_SupportedFanModes')
  const bitmap = Number(raw)

  const speeds = new Set<FanMode>()
  if (Number.isFinite(bitmap) && bitmap > 0) {
    for (const mode of FAN_ORDER) {
      if (bitmap & (FAN_BIT[mode] ?? 0))
        speeds.add(mode)
    }
  }
  // Fallback baseline: bitmap absent, zero, or decoded to nothing usable.
  if (speeds.size === 0) {
    speeds.add(FanMode.LOW)
    speeds.add(FanMode.MEDIUM)
    speeds.add(FanMode.HIGH)
  }

  // Union in the speed the unit is currently running, even if the bitmap omitted it.
  const currentRaw = state.get<string>('UserAirconSettings.FanMode')
  const current = currentRaw?.replace('+CONT', '') as FanMode | undefined
  if (current && FAN_ORDER.includes(current))
    speeds.add(current)

  // NV_AutoFanEnabled is a gate, not an override: AUTO only survives if the bitmap (or the
  // currently-running mode) put it in the set AND the unit explicitly reports auto-fan support.
  if (state.get<boolean>('AirconSystem.IndoorUnit.NV_AutoFanEnabled') !== true)
    speeds.delete(FanMode.AUTO)

  // Re-check the "never empty" baseline: an AUTO-only bitmap (valid decode, size 1) skips
  // the earlier fallback, then the AUTO gate above can empty the set out entirely.
  if (speeds.size === 0) {
    speeds.add(FanMode.LOW)
    speeds.add(FanMode.MEDIUM)
    speeds.add(FanMode.HIGH)
  }

  return FAN_ORDER.filter(mode => speeds.has(mode))
}

export function deriveCapabilities(state: NeoState): NeoCapabilities {
  const masterModel = state.get<string>('AirconSystem.MasterWCModel')
  const indoorModel = state.get<string>('AirconSystem.IndoorUnit.NV_ModelNumber')
  const fanSpeeds = deriveFanSpeeds(state)

  return {
    model: masterModel || indoorModel || 'ActronAir Neo (model unknown)',
    indoorModel,
    outdoorFamily: state.get<string>('AirconSystem.OutdoorUnit.Family'),
    capacityKw: state.get<number>('AirconSystem.OutdoorUnit.Capacity_kW'),
    modes: deriveModeSupport(state),
    fanSpeeds,
    supportsAutoFan: fanSpeeds.includes(FanMode.AUTO),
    supportsTurbo: isTurboModeSupported(state),
    supportsVft: state.get<boolean>('UserAirconSettings.VFT.Supported') === true,
    quietModeAvailable: state.get<boolean>('UserAirconSettings.QuietModeEnabled') === true,
    outdoorTempUsable: getUsableOutdoorTemp(state) !== undefined,
  }
}

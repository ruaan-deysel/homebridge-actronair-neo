import { z } from 'zod'
import { normalizeDeltaPath } from './paths.js'

/**
 * Schemas describe ONLY the fields the plugin consumes; everything else passes through.
 * New upstream fields never break us, but a field we depend on going missing fails loudly
 * with a precise path.
 */

/**
 * A numeric field the cloud sometimes sends as a string. Coercion of string digits is
 * deliberate (see the field comments below), but the cloud ALSO uses `"NA"` for an absent
 * numeric — the captured fixture contains 64 of them, four at
 * `AirconSystem.Peripherals[N].RSSI.Remote`, the immediate sibling of the coerced
 * `RSSI.Local`. `z.coerce.number()` turns `"NA"` into NaN and fails, and since these live
 * inside the one status tree, a single "NA" would fail the ENTIRE parse: no state update,
 * every accessory frozen on stale values, every control "No Response". `null`/`""` were
 * worse still — they coerce to a silent, wrong `0`.
 *
 * So: absent-numeric sentinels map to `undefined` (the same thing the field simply being
 * missing means, which every consumer already handles), everything else coerces as before.
 */
const ABSENT_NUMERIC = new Set<unknown>(['NA', null, ''])
const numeric = z.preprocess(
  v => (ABSENT_NUMERIC.has(v) ? undefined : v),
  z.coerce.number().optional(),
)

/**
 * RemoteZoneInfo[i].Sensors is keyed by the *system serial* (same key repeats across every
 * zone) — never a sensor id. Identity lives in NV_Kind: "ZS: <serial>" for a wireless zone
 * sensor (joined against AirconSystem.Peripherals by serial), or a bus designator like "C1"
 * for a wired sensor (joined against AirconSystem.Sensors by designator). See neo/sensors.ts.
 */
const ZoneSensorEntrySchema = z.looseObject({
  NV_Kind: z.string().optional(),
})

export const ZoneInfoSchema = z.looseObject({
  NV_Exists: z.boolean().optional(),
  NV_Title: z.string().optional(),
  // All `numeric`: a zone's live reading is the field most likely to go absent (the sensor
  // drops out), and one "NA" on a plain numeric would otherwise fail the whole status parse.
  LiveTemp_oC: numeric,
  LiveHumidity_pc: numeric,
  MaxHeatSetpoint: numeric,
  MinHeatSetpoint: numeric,
  MaxCoolSetpoint: numeric,
  MinCoolSetpoint: numeric,
  TemperatureSetpoint_Heat_oC: numeric,
  TemperatureSetpoint_Cool_oC: numeric,
  Sensors: z.record(z.string(), ZoneSensorEntrySchema).optional(),
})

export const UserAirconSettingsSchema = z.looseObject({
  isOn: z.boolean(),
  Mode: z.string(),
  FanMode: z.string(),
  AwayMode: z.boolean().optional(),
  QuietMode: z.boolean().optional(),
  EnabledZones: z.array(z.boolean()).default([]),
  TemperatureSetpoint_Cool_oC: numeric,
  TemperatureSetpoint_Heat_oC: numeric,
  AfterHours: z.looseObject({
    Enabled: z.boolean().optional(),
    // Coerced consistent with NV_Limits: this feeds a write path (the duration
    // characteristic's clamped range), so a silent string-concat bug is not acceptable.
    Duration: numeric,
  }).optional(),
  TurboMode: z.looseObject({
    // Capability gate — the accessory is only registered when this is true. See
    // isTurboModeSupported() in neo/capabilities.ts.
    Supported: z.boolean().optional(),
    Enabled: z.boolean().optional(),
  }).optional(),
  // Capability gate consumed by neo/capabilities.ts (NeoCapabilities.supportsVft).
  VFT: z.looseObject({
    Supported: z.boolean().optional(),
  }).optional(),
  // Capability gate consumed by neo/capabilities.ts (NeoCapabilities.quietModeAvailable) —
  // distinct from QuietMode, which is the on/off state ModeSwitchAccessory reads/writes.
  QuietModeEnabled: z.boolean().optional(),
})

/**
 * Model/capability identity, consumed by neo/capabilities.ts to derive NeoCapabilities
 * (fan speeds, AUTO support, model label for AccessoryInformation, etc).
 */
export const AirconSystemSchema = z.looseObject({
  MasterWCModel: z.string().optional(),
  IndoorUnit: z.looseObject({
    NV_ModelNumber: z.string().optional(),
    // Bitmap: 1=LOW, 2=MED, 4=HIGH, 8=AUTO. Coerced — cloud numerics have arrived as
    // strings elsewhere (see ConnectionDetailsSchema.Port), and this feeds fan-speed
    // capability detection directly.
    NV_SupportedFanModes: numeric,
    NV_AutoFanEnabled: z.boolean().optional(),
  }).optional(),
  OutdoorUnit: z.looseObject({
    Family: z.string().optional(),
    Capacity_kW: numeric,
  }).optional(),
  /**
   * Wireless zone sensors. Joined against RemoteZoneInfo[i].Sensors[key].NV_Kind ("ZS:
   * <SerialNumber>") by neo/sensors.ts to resolve real per-zone battery/RSSI/connection —
   * NOT read directly by any accessory.
   */
  Peripherals: z.array(z.looseObject({
    SerialNumber: z.string().optional(),
    ConnectionState: z.string().optional(),
    // Coerced consistent with NV_Limits/OutdoorUnit — cloud numerics have arrived as
    // strings elsewhere, and this feeds the zone Battery service directly.
    RemainingBatteryCapacity_pc: numeric,
    RSSI: z.looseObject({
      Local: numeric,
    }).optional(),
  })).optional(),
  /**
   * Wired bus sensors (C1-C3, RS1-RS3). Joined against RemoteZoneInfo[i].Sensors[key].NV_Kind
   * by neo/sensors.ts to resolve wired-zone connection state — these sensors have no battery.
   */
  Sensors: z.array(z.looseObject({
    Designator: z.string().optional(),
    Detected: z.boolean().optional(),
  })).optional(),
})

export const StatusTreeSchema = z.looseObject({
  UserAirconSettings: UserAirconSettingsSchema,
  AirconSystem: AirconSystemSchema.default({}),
  /**
   * Device-reported zone setpoint bounds. Coerced — the live API has sent numbers as
   * strings elsewhere (see ConnectionDetailsSchema.Port), and these values feed a write
   * path (zone setpoint clamping/push), so a silent string-concat bug is not acceptable.
   */
  NV_Limits: z.looseObject({
    UserSetpoint_oC: z.looseObject({
      setCool_Min: numeric,
      setCool_Max: numeric,
      setHeat_Min: numeric,
      setHeat_Max: numeric,
      VarianceAboveMasterCool: numeric,
      VarianceBelowMasterCool: numeric,
      VarianceAboveMasterHeat: numeric,
      VarianceBelowMasterHeat: numeric,
    }).optional(),
  }).optional(),
  MasterInfo: z.looseObject({
    LiveTemp_oC: numeric,
    LiveHumidity_pc: numeric,
    ControlAllZones: z.boolean().optional(),
    // Coerced consistent with NV_Limits: this is a sentinel-bearing numeric (3000 = "no
    // reading") consumed directly by the outdoor temperature sensor gating logic.
    LiveOutdoorTemp_oC: numeric,
  }).default({}),
  LiveAircon: z.looseObject({
    CompressorMode: z.string().optional(),
    AmRunningFan: z.boolean().optional(),
    CompressorChasingTemperature: numeric,
    CompressorLiveTemperature: numeric,
    OutdoorUnit: z.looseObject({
      AmbientSensErr: z.boolean().optional(),
    }).optional(),
  }).default({}),
  RemoteZoneInfo: z.array(ZoneInfoSchema).default([]),
})

export type StatusTree = z.infer<typeof StatusTreeSchema>

/** REST: GET /api/v0/client/ac-systems/status/latest */
export const StatusResponseSchema = z.looseObject({
  isOnline: z.boolean().default(false),
  lastKnownState: StatusTreeSchema,
})

/** MQTT full-status — same tree, but nested under `event` rather than `lastKnownState`. */
export const FullStatusPushSchema = z.looseObject({
  event: StatusTreeSchema,
  wcFirmware: z.string().optional(),
})

/** MQTT status-change — a flat delta of dotted/bracketed paths, not a snapshot. */
export const StatusChangeSchema = z.looseObject({
  event: z.record(z.string(), z.unknown()),
  wcFirmware: z.string().optional(),
})

/**
 * The MQTT delta boundary: `NeoState.applyDelta()` (state.ts) only ever writes a path/value
 * pair that appears here, keyed by its bracket-normalized form (see normalizeDeltaPath) so
 * one entry covers every `RemoteZoneInfo[N]` / `AirconSystem.Peripherals[N]` /
 * `AirconSystem.Sensors[N]` index instead of enumerating indices. Everything else is
 * reported as rejected, never stored — status-change payloads are untrusted network input,
 * unlike REST/full-status which is Zod-validated as a whole tree via StatusTreeSchema.
 *
 * This list is deliberately narrower than StatusTreeSchema: only paths some accessory,
 * capability getter, or sensor resolver actually calls `state.get()` on (see the WATCHED
 * tables in src/accessories/*.ts and src/neo/capabilities.ts). A field like
 * LiveAircon.CompressorLiveTemperature is real and REST-validated but nothing reads it via
 * applyDelta's path today, so it is intentionally absent — add it here when something starts
 * consuming it, not preemptively.
 *
 * Reject-vs-coerce follows the same rule schemas.ts already uses elsewhere: every numeric
 * field uses the shared `numeric` schema above (string digits coerced, "NA"/null/"" →
 * undefined, matching what the REST tree accepts for the same field); everything else
 * (including booleans — never coerced, "true" is not true) must arrive as its real type or
 * the whole delta is rejected.
 */
const ALLOWED_DELTA_PATHS: Record<string, z.ZodTypeAny> = {
  'UserAirconSettings.isOn': z.boolean(),
  'UserAirconSettings.Mode': z.string(),
  'UserAirconSettings.FanMode': z.string(),
  'UserAirconSettings.AwayMode': z.boolean(),
  'UserAirconSettings.QuietMode': z.boolean(),
  'UserAirconSettings.EnabledZones': z.array(z.boolean()),
  'UserAirconSettings.TemperatureSetpoint_Cool_oC': numeric,
  'UserAirconSettings.TemperatureSetpoint_Heat_oC': numeric,
  'UserAirconSettings.AfterHours.Enabled': z.boolean(),
  'UserAirconSettings.AfterHours.Duration': numeric,
  'UserAirconSettings.TurboMode.Supported': z.boolean(),
  'UserAirconSettings.TurboMode.Enabled': z.boolean(),
  'UserAirconSettings.VFT.Supported': z.boolean(),
  'UserAirconSettings.QuietModeEnabled': z.boolean(),

  'AirconSystem.MasterWCModel': z.string(),
  'AirconSystem.IndoorUnit.NV_ModelNumber': z.string(),
  'AirconSystem.IndoorUnit.NV_SupportedFanModes': numeric,
  'AirconSystem.IndoorUnit.NV_AutoFanEnabled': z.boolean(),
  'AirconSystem.OutdoorUnit.Family': z.string(),
  'AirconSystem.OutdoorUnit.Capacity_kW': numeric,
  'AirconSystem.Peripherals[].SerialNumber': z.string(),
  'AirconSystem.Peripherals[].ConnectionState': z.string(),
  'AirconSystem.Peripherals[].RemainingBatteryCapacity_pc': numeric,
  'AirconSystem.Peripherals[].RSSI.Local': numeric,
  'AirconSystem.Sensors[].Designator': z.string(),
  'AirconSystem.Sensors[].Detected': z.boolean(),

  'NV_Limits.UserSetpoint_oC.setCool_Min': numeric,
  'NV_Limits.UserSetpoint_oC.setCool_Max': numeric,
  'NV_Limits.UserSetpoint_oC.setHeat_Min': numeric,
  'NV_Limits.UserSetpoint_oC.setHeat_Max': numeric,
  'NV_Limits.UserSetpoint_oC.VarianceAboveMasterCool': numeric,
  'NV_Limits.UserSetpoint_oC.VarianceBelowMasterCool': numeric,
  'NV_Limits.UserSetpoint_oC.VarianceAboveMasterHeat': numeric,
  'NV_Limits.UserSetpoint_oC.VarianceBelowMasterHeat': numeric,

  'MasterInfo.LiveTemp_oC': numeric,
  'MasterInfo.LiveHumidity_pc': numeric,
  'MasterInfo.LiveOutdoorTemp_oC': numeric,

  'LiveAircon.CompressorMode': z.string(),
  'LiveAircon.AmRunningFan': z.boolean(),
  'LiveAircon.OutdoorUnit.AmbientSensErr': z.boolean(),

  'RemoteZoneInfo[].NV_Exists': z.boolean(),
  'RemoteZoneInfo[].NV_Title': z.string(),
  'RemoteZoneInfo[].LiveTemp_oC': numeric,
  'RemoteZoneInfo[].LiveHumidity_pc': numeric,
  'RemoteZoneInfo[].MaxHeatSetpoint': numeric,
  'RemoteZoneInfo[].MinHeatSetpoint': numeric,
  'RemoteZoneInfo[].MaxCoolSetpoint': numeric,
  'RemoteZoneInfo[].MinCoolSetpoint': numeric,
  'RemoteZoneInfo[].TemperatureSetpoint_Heat_oC': numeric,
  'RemoteZoneInfo[].TemperatureSetpoint_Cool_oC': numeric,
}

export type DeltaValidation
  = | { ok: true, value: unknown }
    /**
     * Path isn't one this plugin reads. Live broker capture (see state.ts applyDelta) shows
     * the cloud routinely bundles fields we don't consume (e.g. ZonePosition, OutdoorUnit.
     * RoomTemp) alongside ones we do in the same broadcast — this is normal traffic, not a
     * malformed message, so the caller must not treat it as a reason to reject the delta.
     */
    | { ok: false, kind: 'unknown-path', reason: string }
    /** Path is allowlisted but the value doesn't fit its expected type — a real problem. */
    | { ok: false, kind: 'invalid-value', reason: string }

/**
 * Validate a single status-change path/value pair against the allowlist above. Returns the
 * parsed (possibly coerced) value on success so the caller writes what was actually
 * validated, not the raw wire value.
 */
export function validateDeltaValue(path: string, value: unknown): DeltaValidation {
  const schema = ALLOWED_DELTA_PATHS[normalizeDeltaPath(path)]
  if (!schema)
    return { ok: false, kind: 'unknown-path', reason: 'not a path this plugin reads' }

  const parsed = schema.safeParse(value)
  if (!parsed.success)
    return { ok: false, kind: 'invalid-value', reason: parsed.error.issues.map(issue => issue.message).join('; ') }

  return { ok: true, value: parsed.data }
}

/** GET /api/v0/messaging/connection/details — PascalCase keys, Port arrives as a string. */
export const ConnectionDetailsSchema = z.looseObject({
  Endpoint: z.string(),
  Port: z.coerce.number().int().positive(),
  Protocol: z.string(),
  UserId: z.string(),
})

export const AcSystemsSchema = z.looseObject({
  _embedded: z.object({
    'ac-system': z.array(z.looseObject({
      serial: z.string(),
      id: z.string().optional(),
      type: z.string().optional(),
      description: z.string().optional(),
    })),
  }),
})

export const DeviceCodeSchema = z.looseObject({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  interval: z.number().int().positive().default(5),
  expires_in: z.number().int().positive().default(1800),
})

/** Refresh does NOT return a new refresh_token, so it is optional. */
export const TokenSchema = z.looseObject({
  access_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().optional(),
})

export const AccountSchema = z.looseObject({
  id: z.string().optional(),
  email: z.string().optional(),
  fullName: z.string().optional(),
})

export const CommandResponseSchema = z.looseObject({
  type: z.string(),
  correlationId: z.string().optional(),
  value: z.unknown().optional(),
})

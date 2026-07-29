import type { NeoState } from './state.js'

/**
 * Per-zone physical sensor resolution. Lives in its own module rather than capabilities.ts:
 * NeoCapabilities is a device-wide snapshot derived once per poll ("what can this unit do"),
 * while a zone's sensor identity/battery/RSSI/connection is per-zone, resolved on demand from
 * two joins — a shape that doesn't fit the single deriveCapabilities() object.
 */

export type ZoneSensorKind = 'wired' | 'wireless' | 'unknown'

export interface ZoneSensorInfo {
  kind: ZoneSensorKind
  /** Wireless only, and only when the serial resolves against AirconSystem.Peripherals. */
  batteryPct?: number
  /** Wireless only — Peripherals[].RSSI.Local. */
  rssi?: number
  /** Wireless: Peripherals[].ConnectionState === 'Connected'. Wired: bus Sensors[].Detected. */
  connected?: boolean
}

interface ZoneSensorEntry {
  NV_Kind?: string
}

interface Peripheral {
  SerialNumber?: string
  ConnectionState?: string
  RemainingBatteryCapacity_pc?: number
  RSSI?: { Local?: number }
}

interface BusSensor {
  Designator?: string
  Detected?: boolean
}

const WIRELESS_PREFIX = 'ZS: '

/**
 * Resolves zone `zoneIndex`'s physical sensor. RemoteZoneInfo[i].Sensors is keyed by the
 * system serial — the same key repeats for every zone, so it is never a sensor id. Identity
 * lives in the single entry's NV_Kind: "ZS: <serial>" for a wireless zone sensor, or a bus
 * designator ("C1", "RS2", ...) for a wired one.
 *
 * Wireless zones then join AirconSystem.Peripherals by serial for battery/RSSI/connection.
 * Wired zones join AirconSystem.Sensors by designator for connection only — wired sensors
 * have no battery. A join that finds nothing leaves those fields `undefined`; nothing here
 * ever fabricates a value (in particular, no minimum-across-Object.values(Sensors) — those
 * entries carry no battery field at all).
 */
export function resolveZoneSensor(state: NeoState, zoneIndex: number): ZoneSensorInfo {
  const sensors = state.get<Record<string, ZoneSensorEntry>>(`RemoteZoneInfo[${zoneIndex}].Sensors`)
  const kindRaw = sensors ? Object.values(sensors)[0]?.NV_Kind : undefined
  if (!kindRaw)
    return { kind: 'unknown' }

  if (kindRaw.startsWith(WIRELESS_PREFIX)) {
    const serial = kindRaw.slice(WIRELESS_PREFIX.length).trim()
    const peripheral = state.get<Peripheral[]>('AirconSystem.Peripherals')?.find(p => p.SerialNumber === serial)
    return {
      kind: 'wireless',
      batteryPct: peripheral?.RemainingBatteryCapacity_pc,
      rssi: peripheral?.RSSI?.Local,
      connected: peripheral ? peripheral.ConnectionState === 'Connected' : undefined,
    }
  }

  const bus = state.get<BusSensor[]>('AirconSystem.Sensors')?.find(s => s.Designator === kindRaw)
  return {
    kind: 'wired',
    connected: bus ? bus.Detected === true : undefined,
  }
}

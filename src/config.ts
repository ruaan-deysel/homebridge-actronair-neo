import { z } from 'zod'

/**
 * Plugin config as it appears in config.json. Every field is optional except the
 * Homebridge-supplied ones; defaults live here rather than scattered across the platform.
 *
 * The option set is deliberately at parity with the reference Home Assistant integration
 * (ha-actronair-neo): knobs it doesn't expose aren't exposed here either. `looseObject` means
 * a config still carrying a removed key (pushEnabled, commandDebounceMs, setpointDebounceMs,
 * zonesPushMaster, min/max{Heating,Cooling}Temp) is ignored silently rather than failing to
 * start — see test/config.test.ts.
 */
const ConfigSchema = z.looseObject({
  name: z.string().default('ActronAir Neo'),

  /** OAuth2 refresh token written by the custom settings UI. Absent until linked. */
  refreshToken: z.string().optional(),

  /** Only needed on accounts with more than one system. */
  deviceSerial: z.string().optional(),

  /** OAuth2 client id. Overridable in case ActronAir issues a plugin-specific one. */
  clientId: z.string().default('home_assistant'),

  refreshInterval: z.number().int().positive().default(60),

  zonesAsHeaterCoolers: z.boolean().default(false),

  debug: z.boolean().default(false),
})

export interface NeoConfig extends z.infer<typeof ConfigSchema> {
  refreshIntervalMs: number
}

export function parseConfig(raw: unknown): NeoConfig {
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid plugin configuration — ${issues}`)
  }
  return { ...parsed.data, refreshIntervalMs: parsed.data.refreshInterval * 1000 }
}

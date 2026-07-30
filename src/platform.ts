import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge'
import type { NeoConfig } from './config.js'
import type { NeoCapabilities } from './neo/capabilities.js'
import { AfterHoursAccessory } from './accessories/afterHours.js'
import { MasterAccessory } from './accessories/master.js'
import { ModeSwitchAccessory } from './accessories/modeSwitch.js'
import { OutdoorTempAccessory } from './accessories/outdoorTemp.js'
import { ZoneAccessory } from './accessories/zone.js'
import { parseConfig } from './config.js'
import { NeoAuth, NeoAuthRevokedError } from './neo/auth.js'
import { deriveCapabilities } from './neo/capabilities.js'
import { CommandQueue } from './neo/commands.js'
import { NeoMqtt } from './neo/mqtt.js'
import { NeoRest } from './neo/rest.js'
import { NeoState } from './neo/state.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

const BASE_URL = 'https://nimbus.actronair.com.au'

/** REST poll cadence used once push updates are healthy — polling never stops, just slows down. */
const PUSH_HEALTHY_POLL_MS = 5 * 60 * 1000

/**
 * HAP requires an accessory name to start and end with a letter or number, and warns that a
 * name breaking that rule may stop the accessory being added in the Home app or leave it
 * unresponsive. Zone names come from whatever the user typed in the ActronAir app, where a
 * trailing space is easy to leave behind and invisible afterwards — so trim rather than
 * pass it through and let HomeKit misbehave. Interior punctuation is left alone; only the
 * edges matter to HAP.
 */
export function sanitizeAccessoryName(name: string, fallback: string): string {
  const trimmed = name.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
  return trimmed || fallback
}

/** Consecutive failed polls before the failure is raised from debug to a visible warning. */
const POLL_FAILURE_WARN_AFTER = 3

/**
 * Homebridge gates `log.debug` on its own global `-D` flag, so the plugin's `debug` config
 * option would otherwise do nothing at all. Routing debug through `info` when it's set is
 * what makes the option real — without touching Homebridge's own behaviour when it isn't.
 * Every collaborator (NeoRest, NeoAuth, NeoMqtt, CommandQueue, the accessories) is handed
 * this same wrapped logger, or the option would only half-work.
 */
function withDebugLogging(log: Logging): Logging {
  return new Proxy(log, {
    get: (target, prop, receiver) =>
      prop === 'debug' ? target.info.bind(target) : Reflect.get(target, prop, receiver),
  })
}

interface Discovered {
  id: string
  displayName: string
  kind: 'master' | 'zone' | 'away' | 'quiet' | 'continuousFan' | 'outdoorTemp' | 'afterHours' | 'turbo'
  zoneIndex?: number
}

export class ActronAirNeoPlatform implements DynamicPlatformPlugin {
  public readonly log: Logging
  public readonly Service: typeof Service
  public readonly Characteristic: typeof Characteristic
  public readonly accessories: PlatformAccessory[] = []
  public readonly state = new NeoState()
  public readonly cfg: NeoConfig

  public serial = ''
  public commands!: CommandQueue
  /** Derived once per successful status fetch — see discoverDevices()/poll(). */
  public capabilities?: NeoCapabilities
  private rest!: NeoRest
  private auth?: NeoAuth
  private mqtt?: NeoMqtt
  private pollTimer?: NodeJS.Timeout
  /**
   * Guards against an overlapping poll (retries/timeouts can make one run longer than
   * the poll interval) wasting requests against the cloud's ~20/min rate limit.
   */
  private polling = false
  /**
   * Set once by the `shutdown` handler. Without this, a poll already in flight when
   * shutdown fires still runs its `.finally(() => this.startPolling())` and resurrects the
   * timer right after `clearTimeout` cleared it.
   */
  private shuttingDown = false
  /** Consecutive poll failures — see the catch in poll(). */
  private pollFailures = 0
  /** The re-link message is actionable exactly once, not once every poll until they act. */
  private revokedLogged = false

  constructor(log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.cfg = parseConfig(config)
    this.log = this.cfg.debug ? withDebugLogging(log) : log

    if (this.cfg.refreshToken) {
      this.auth = new NeoAuth({
        baseUrl: BASE_URL,
        clientId: this.cfg.clientId,
        refreshToken: this.cfg.refreshToken,
        log: this.log,
      })
      this.rest = new NeoRest({ baseUrl: BASE_URL, auth: this.auth, log: this.log })
    }

    // Keep CommandQueue's local EnabledZones array in step with whatever transport last
    // updated state. Reconciling only from poll() left a window of up to PUSH_HEALTHY_POLL_MS
    // where a zone changed in the ActronAir app was still "on" in the queue — and the next
    // HomeKit zone toggle, which always sends the whole array, would silently revert it.
    // syncEnabledZones() keeps its own guard against clobbering a still-pending toggle.
    this.state.onChange((changed) => {
      if (changed.has('*') || [...changed].some(path => path.startsWith('UserAirconSettings.EnabledZones')))
        this.commands?.syncEnabledZones(this.state.get<boolean[]>('UserAirconSettings.EnabledZones') ?? [])
    })

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((error: unknown) => {
        this.log.error(`Unexpected error during device discovery: ${(error as Error).message}`)
      })
    })
    this.api.on('shutdown', () => {
      this.shuttingDown = true
      clearTimeout(this.pollTimer)
      this.mqtt?.stop()
      this.commands?.cancelPending()
    })
  }

  /** Test seam — lets tests supply a stub REST client. */
  injectForTest(rest: NeoRest): void {
    this.rest = rest
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`)
    this.accessories.push(accessory)
  }

  async discoverDevices(): Promise<void> {
    if (!this.rest) {
      this.log.warn(
        'ActronAir account is not linked — open the plugin settings and link your account to start the plugin.',
      )
      return
    }

    let discovered: Discovered[]
    try {
      const systems = await this.rest.getSystems()
      const list = systems._embedded['ac-system']
      const target = this.cfg.deviceSerial
        ? list.find(s => s.serial === this.cfg.deviceSerial)
        : list[0]
      if (!target)
        throw new Error(`No system matching serial ${this.cfg.deviceSerial}`)
      this.serial = target.serial

      const status = await this.rest.getStatus(this.serial)
      this.state.setCloudConnected(status.isOnline)
      this.state.replace(status.lastKnownState)

      this.capabilities = deriveCapabilities(this.state)
      this.log.info(
        `Detected ${this.capabilities.model}`
        + ` (indoor: ${this.capabilities.indoorModel ?? 'unknown'}, outdoor: ${this.capabilities.outdoorFamily ?? 'unknown'}`
        + `${this.capabilities.capacityKw ? `, ${this.capabilities.capacityKw}kW` : ''}).`
        + ` Modes: ${Object.entries(this.capabilities.modes).filter(([, on]) => on).map(([mode]) => mode).join(', ')}.`
        + ` Fan speeds: ${this.capabilities.fanSpeeds.join(', ')}.`
        + ` Turbo: ${this.capabilities.supportsTurbo}, VFT: ${this.capabilities.supportsVft},`
        + ` quiet mode: ${this.capabilities.quietModeAvailable}, outdoor temp: ${this.capabilities.outdoorTempUsable}.`,
      )

      this.commands = new CommandQueue({
        rest: this.rest,
        serial: this.serial,
        log: this.log,
      })
      this.commands.syncEnabledZones(status.lastKnownState.UserAirconSettings.EnabledZones)
      this.startPush()

      discovered = [
        // Sanitised like a zone name: `name` is free text in config.json, and it now seeds the
        // fan service's ConfiguredName as well as its own — HAP validates both.
        { id: this.serial, displayName: sanitizeAccessoryName(this.cfg.name, 'ActronAir Neo'), kind: 'master' },
        { id: 'neo-away-mode', displayName: 'Away Mode', kind: 'away' },
        // Only registered when the unit reports QuietModeEnabled — see NeoCapabilities.
        ...(this.capabilities.quietModeAvailable
          ? [{ id: 'neo-quiet-mode', displayName: 'Quiet Mode', kind: 'quiet' as const }]
          : []),
        { id: 'neo-continuous-fan-mode', displayName: 'Continuous Mode', kind: 'continuousFan' },
        { id: 'neo-after-hours-mode', displayName: 'After Hours', kind: 'afterHours' },
        // Only registered when the reading is usable — see NeoCapabilities.outdoorTempUsable.
        // A sentinel (3000), sensor error, or implausible value would otherwise permanently
        // stick an invalid CurrentTemperature accessory in HomeKit.
        ...(this.capabilities.outdoorTempUsable
          ? [{ id: 'neo-outdoor-temp', displayName: 'Outdoor Temperature', kind: 'outdoorTemp' as const }]
          : []),
        // Only registered when the unit reports TurboMode.Supported — exposing a control
        // the hardware can't honour would give a switch that silently does nothing.
        ...(this.capabilities.supportsTurbo
          ? [{ id: 'neo-turbo-mode', displayName: 'Turbo Mode', kind: 'turbo' as const }]
          : []),
        ...status.lastKnownState.RemoteZoneInfo
          .map((zone, zoneIndex) => ({ zone, zoneIndex }))
          .filter(({ zone }) => zone.NV_Exists && zone.NV_Title)
          .map(({ zone, zoneIndex }) => ({
            // Index-only, deliberately not including NV_Title: RemoteZoneInfo is a fixed-size
            // array keyed by physical zone slot, and the name is user-editable in the ActronAir
            // app — folding it into the identity meant a rename orphaned the HomeKit accessory
            // (lost room placement, scenes, automations). See syncAccessories() for migration
            // of accessories cached under the old `zone-${index}-${title}` scheme.
            id: `zone-${zoneIndex}`,
            displayName: sanitizeAccessoryName(zone.NV_Title as string, `Zone ${zoneIndex + 1}`),
            kind: 'zone' as const,
            zoneIndex,
          })),
      ]
    }
    catch (error) {
      // CRITICAL: a failed discovery must never remove cached accessories, or a cloud
      // outage would wipe the user's HomeKit rooms and automations.
      this.log.error(`Device discovery failed: ${(error as Error).message}`)
      this.log.error('Keeping existing accessories. The plugin will retry on the next poll.')
      this.startPolling()
      return
    }

    // Accessory construction (Tasks 8-10) touches real HAP characteristics and can throw.
    // That must never propagate out of discovery — it runs in its own protected region so
    // a bad accessory logs and is skipped rather than crashing the platform.
    try {
      this.syncAccessories(discovered)
    }
    catch (error) {
      this.log.error(`Accessory sync failed: ${(error as Error).message}`)
    }
    this.startPolling()
  }

  private syncAccessories(discovered: Discovered[]): void {
    const wanted = new Set<string>()

    for (const device of discovered) {
      const uuid = this.resolveZoneUuid(device) ?? this.api.hap.uuid.generate(device.id)
      if (wanted.has(uuid)) {
        // Zone names are user-editable and can collide (including near-collisions like a
        // trailing space); the id already includes the zone index, so this only fires for
        // a genuine identity clash, which would otherwise silently drop an accessory.
        this.log.warn(`Two discovered accessories produced the same identity ("${device.displayName}") — one will not be shown in HomeKit. Check for duplicate zone names.`)
        continue
      }
      wanted.add(uuid)
      const existing = this.accessories.find(a => a.UUID === uuid)
      const PlatformAccessoryCtor = this.api.platformAccessory
      const accessory = existing ?? new PlatformAccessoryCtor(device.displayName, uuid)
      accessory.context.device = device

      // A cached accessory keeps the name it was registered under, so a rename in the
      // ActronAir app — or a name this plugin has since had to sanitise for HAP — would stay
      // stale forever, and HAP would keep warning about it on every restart.
      const renamed = existing && accessory.displayName !== device.displayName
      if (renamed)
        accessory.displayName = device.displayName

      try {
        this.build(device, accessory)
      }
      catch (error) {
        // One broken accessory must not stop the others from registering.
        this.log.error(`Failed to initialize accessory "${device.displayName}": ${(error as Error).message}`)
      }

      if (existing) {
        this.log.info(`Restoring accessory from cache: ${accessory.displayName}`)
        // Each service carries its own cached Name. Accessories set it on the service they own,
        // but a zone also has temperature/humidity/battery services whose names would keep a
        // stale value in the Home app. Reconcile every service against displayName rather than
        // only when displayName itself just changed — once displayName has been corrected on an
        // earlier run, that condition is false while the service names are still wrong.
        // Names a service is allowed to carry: the accessory's own, plus the ones an accessory
        // deliberately derives from it — MasterAccessory's fan-only service is "<name> Fan",
        // and reconciling that away would leave two identically-named tiles in the Home app.
        // Exact names rather than a prefix test, and only for the accessory that actually owns
        // such a service: either shortcut would exempt a genuinely stale name (a zone renamed
        // "Study Fan" → "Study" keeps sub-services cached as "Study Fan"), which is the drift
        // this loop exists to fix.
        const allowedServiceNames = new Set([accessory.displayName])
        if (device.kind === 'master')
          allowedServiceNames.add(`${accessory.displayName} Fan`)
        let staleServiceName = false
        for (const service of accessory.services) {
          if (!service.testCharacteristic(this.Characteristic.Name))
            continue
          const name = service.getCharacteristic(this.Characteristic.Name).value
          if (typeof name === 'string' && allowedServiceNames.has(name))
            continue
          service.updateCharacteristic(this.Characteristic.Name, accessory.displayName)
          staleServiceName = true
        }
        // Persist only on a real change; without the write the cache is rebuilt from the old
        // value on next shutdown, with it every restart would rewrite the cache for nothing.
        if (renamed || staleServiceName)
          this.api.updatePlatformAccessories([accessory])
      }
      else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.push(accessory)
      }
    }

    const stale = this.accessories.filter(a => !wanted.has(a.UUID))
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessories that are no longer present`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
      for (const accessory of stale) {
        const index = this.accessories.indexOf(accessory)
        if (index !== -1)
          this.accessories.splice(index, 1)
      }
    }
  }

  /**
   * Migration for zone identity (see the `id` comment above): a zone accessory already
   * cached under the old `zone-${index}-${title}` UUID must be adopted rather than orphaned
   * when the id scheme changes underneath it. A PlatformAccessory's UUID is fixed at
   * construction, so migration means *reusing* the existing accessory's UUID going forward
   * rather than recomputing one — matched by zoneIndex, the one thing both schemes agree on
   * for the same physical zone slot. Fresh installs (no cached match) fall through to
   * `uuid.generate(device.id)` in the caller.
   */
  private resolveZoneUuid(device: Discovered): string | undefined {
    if (device.kind !== 'zone')
      return undefined
    const cached = this.accessories.find(a => a.context.device?.kind === 'zone' && a.context.device?.zoneIndex === device.zoneIndex)
    if (!cached)
      return undefined
    // The adopted UUID can never equal a freshly generated new-scheme one — that's the whole
    // point of keeping the old identity — so this condition alone would fire on every restart
    // forever. `zoneIdMigrated` is persisted on the accessory's context (saved with the cached
    // accessory) so the log only fires once, at the restart where the adoption actually happens.
    if (cached.UUID !== this.api.hap.uuid.generate(device.id) && !cached.context.zoneIdMigrated) {
      this.log.info(`Migrating zone ${device.zoneIndex} ("${device.displayName}") to the new stable identity — keeping the existing accessory (room placement, scenes and automations are preserved).`)
      cached.context.zoneIdMigrated = true
    }
    return cached.UUID
  }

  private build(device: Discovered, accessory: PlatformAccessory): void {
    switch (device.kind) {
      case 'master':
        // eslint-disable-next-line no-new
        new MasterAccessory(this, accessory)
        break
      case 'zone':
        // eslint-disable-next-line no-new
        new ZoneAccessory(this, accessory, device.zoneIndex!)
        break
      case 'away':
        // eslint-disable-next-line no-new
        new ModeSwitchAccessory(this, accessory, 'away')
        break
      case 'quiet':
        // eslint-disable-next-line no-new
        new ModeSwitchAccessory(this, accessory, 'quiet')
        break
      case 'continuousFan':
        // eslint-disable-next-line no-new
        new ModeSwitchAccessory(this, accessory, 'continuousFan')
        break
      case 'outdoorTemp':
        // eslint-disable-next-line no-new
        new OutdoorTempAccessory(this, accessory)
        break
      case 'afterHours':
        // eslint-disable-next-line no-new
        new AfterHoursAccessory(this, accessory)
        break
      case 'turbo':
        // eslint-disable-next-line no-new
        new ModeSwitchAccessory(this, accessory, 'turbo')
        break
    }
  }

  /**
   * Connects the MQTT push transport once per platform lifetime — always on, matching the
   * reference HA integration (there is no opt-out). Never blocks startup and
   * never throws — every failure inside NeoMqtt (discovery, TLS, auth, a bad payload) is
   * caught, logged and retried with backoff; polling keeps running unaffected either way.
   */
  private startPush(): void {
    if (this.mqtt || !this.auth)
      return
    this.mqtt = new NeoMqtt({
      rest: this.rest,
      auth: this.auth,
      state: this.state,
      serial: this.serial,
      log: this.log,
      // Re-time the poll loop the instant push's health flips, rather than waiting for the
      // next scheduled tick to notice — see startPolling().
      onHealthChange: () => this.startPolling(),
    })
    this.mqtt.start().catch((error: unknown) => {
      this.log.debug(`MQTT push failed to start, continuing on REST polling: ${(error as Error).message}`)
    })
  }

  /**
   * Single poll loop for the whole platform — accessories no longer own timers. Self-
   * reschedules on a setTimeout (rather than a fixed setInterval) so the interval can widen
   * once push updates are healthy and narrow again the moment they go stale or down (driven
   * by NeoMqtt's onHealthChange callback, not just the end of each poll).
   *
   * Note the zone-wipe safeguard NeoMqtt applies to push/resync updates is deliberately NOT
   * applied to the plain `state.replace()` below — see the comment on NeoMqtt.applyReplace()
   * for why leaving this path unguarded is what keeps the safeguard itself from being able to
   * wedge state forever, at the cost of a window of at most one poll interval.
   */
  private startPolling(): void {
    if (this.shuttingDown)
      return
    clearTimeout(this.pollTimer)
    const interval = this.mqtt?.healthy ? PUSH_HEALTHY_POLL_MS : this.cfg.refreshIntervalMs
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.startPolling())
    }, interval)
  }

  private clearFailureCounters(): void {
    this.pollFailures = 0
    this.revokedLogged = false
  }

  async poll(): Promise<void> {
    if (!this.rest || this.polling)
      return
    this.polling = true
    try {
      // A failed initial discovery (e.g. cloud down at Homebridge boot) leaves serial/commands
      // unset. Retry discovery here instead of silently doing nothing forever — otherwise the
      // plugin never recovers without a restart.
      if (!this.serial || !this.commands) {
        await this.discoverDevices()
        // discoverDevices() swallows its own failures, so only a genuine recovery clears the
        // counters — otherwise the next single blip would warn straight away.
        if (this.serial && this.commands)
          this.clearFailureCounters()
        return
      }
      const status = await this.rest.getStatus(this.serial)
      this.state.setCloudConnected(status.isOnline)
      this.state.replace(status.lastKnownState)
      this.commands.syncEnabledZones(status.lastKnownState.UserAirconSettings.EnabledZones)
      this.clearFailureCounters()
    }
    catch (error) {
      // A failed poll means we no longer know the cloud is reachable — leaving cloudConnected
      // true would let checkHvacComms() wave a write through against a connection that's
      // actually down. Clear it so the guard means something; it's set true again as soon as
      // a poll (or a fresh discovery) succeeds.
      this.state.setCloudConnected(false)
      this.pollFailures++
      const message = (error as Error).message
      // A revoked grant is terminal and user-actionable, and repeated failures mean the
      // cloud connection is genuinely broken — neither may stay invisible at debug (which is
      // off unless Homebridge itself runs with -D). A single blip still stays quiet.
      if (error instanceof NeoAuthRevokedError) {
        if (!this.revokedLogged) {
          this.log.error(message)
          this.revokedLogged = true
        }
      }
      else if (this.pollFailures >= POLL_FAILURE_WARN_AFTER) {
        this.log.warn(`Status refresh has failed ${this.pollFailures} times in a row, serving cached state: ${message}`)
      }
      else {
        this.log.debug(`Status refresh failed, serving cached state: ${message}`)
      }
    }
    finally {
      this.polling = false
    }
  }
}

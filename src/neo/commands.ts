import type { Logging } from 'homebridge'
import type { NeoRest } from './rest.js'
import { Debouncer } from './debouncer.js'
import { CommandResult, NeoCommand } from './types.js'

type Builder = (coolTemp: number, heatTemp: number, zoneIndex: number, zones: boolean[], duration: number) => { command: object }

const set = (fields: Record<string, unknown>) => ({ command: { ...fields, type: 'set-settings' } })

export const commandBuilders: Record<string, Builder> = {
  [NeoCommand.ON]: () => set({ 'UserAirconSettings.isOn': true }),
  [NeoCommand.OFF]: () => set({ 'UserAirconSettings.isOn': false }),
  [NeoCommand.CLIMATE_MODE_AUTO]: () => set({ 'UserAirconSettings.Mode': 'AUTO' }),
  [NeoCommand.CLIMATE_MODE_COOL]: () => set({ 'UserAirconSettings.Mode': 'COOL' }),
  [NeoCommand.CLIMATE_MODE_HEAT]: () => set({ 'UserAirconSettings.Mode': 'HEAT' }),
  [NeoCommand.CLIMATE_MODE_FAN]: () => set({ 'UserAirconSettings.Mode': 'FAN' }),
  // Power and mode in a single set-settings, which the cloud accepts (see
  // docs/actron_api_documentation.md, "Power and mode"). Deliberately one command rather than
  // OFF-guarded ON + CLIMATE_MODE_FAN: those two would land on different debounce keys, so a
  // mode change arriving in the same window could replace the FAN half — last write wins — and
  // leave the power half to switch the unit on in whatever mode won.
  [NeoCommand.FAN_ONLY_ON]: () => set({ 'UserAirconSettings.isOn': true, 'UserAirconSettings.Mode': 'FAN' }),
  [NeoCommand.FAN_MODE_AUTO]: () => set({ 'UserAirconSettings.FanMode': 'AUTO' }),
  [NeoCommand.FAN_MODE_AUTO_CONT]: () => set({ 'UserAirconSettings.FanMode': 'AUTO+CONT' }),
  [NeoCommand.FAN_MODE_LOW]: () => set({ 'UserAirconSettings.FanMode': 'LOW' }),
  [NeoCommand.FAN_MODE_LOW_CONT]: () => set({ 'UserAirconSettings.FanMode': 'LOW+CONT' }),
  [NeoCommand.FAN_MODE_MEDIUM]: () => set({ 'UserAirconSettings.FanMode': 'MED' }),
  [NeoCommand.FAN_MODE_MEDIUM_CONT]: () => set({ 'UserAirconSettings.FanMode': 'MED+CONT' }),
  [NeoCommand.FAN_MODE_HIGH]: () => set({ 'UserAirconSettings.FanMode': 'HIGH' }),
  [NeoCommand.FAN_MODE_HIGH_CONT]: () => set({ 'UserAirconSettings.FanMode': 'HIGH+CONT' }),
  [NeoCommand.COOL_SET_POINT]: cool => set({ 'UserAirconSettings.TemperatureSetpoint_Cool_oC': cool }),
  [NeoCommand.HEAT_SET_POINT]: (_c, heat) => set({ 'UserAirconSettings.TemperatureSetpoint_Heat_oC': heat }),
  [NeoCommand.HEAT_COOL_SET_POINT]: (cool, heat) => set({
    'UserAirconSettings.TemperatureSetpoint_Cool_oC': cool,
    'UserAirconSettings.TemperatureSetpoint_Heat_oC': heat,
  }),
  [NeoCommand.AWAY_MODE_ON]: () => set({ 'UserAirconSettings.AwayMode': true }),
  [NeoCommand.AWAY_MODE_OFF]: () => set({ 'UserAirconSettings.AwayMode': false }),
  [NeoCommand.QUIET_MODE_ON]: () => set({ 'UserAirconSettings.QuietMode': true }),
  [NeoCommand.QUIET_MODE_OFF]: () => set({ 'UserAirconSettings.QuietMode': false }),
  [NeoCommand.CONTROL_ALL_ZONES_ON]: () => set({ 'MasterInfo.ControlAllZones': true }),
  [NeoCommand.CONTROL_ALL_ZONES_OFF]: () => set({ 'MasterInfo.ControlAllZones': false }),
  [NeoCommand.ZONE_COOL_SET_POINT]: (cool, _h, zoneIndex) =>
    set({ [`RemoteZoneInfo[${zoneIndex}].TemperatureSetpoint_Cool_oC`]: cool }),
  [NeoCommand.ZONE_HEAT_SET_POINT]: (_c, heat, zoneIndex) =>
    set({ [`RemoteZoneInfo[${zoneIndex}].TemperatureSetpoint_Heat_oC`]: heat }),
  [NeoCommand.AFTER_HOURS_ON]: () => set({ 'UserAirconSettings.AfterHours.Enabled': true }),
  [NeoCommand.AFTER_HOURS_OFF]: () => set({ 'UserAirconSettings.AfterHours.Enabled': false }),
  [NeoCommand.AFTER_HOURS_DURATION]: (_c, _h, _z, _zones, duration) =>
    set({ 'UserAirconSettings.AfterHours.Duration': duration }),
  [NeoCommand.TURBO_MODE_ON]: () => set({ 'UserAirconSettings.TurboMode.Enabled': true }),
  [NeoCommand.TURBO_MODE_OFF]: () => set({ 'UserAirconSettings.TurboMode.Enabled': false }),
}

/** Zone toggles always send the complete desired array, built at flush time. */
export function buildEnabledZones(zones: boolean[]) {
  return set({ 'UserAirconSettings.EnabledZones': [...zones] })
}

/**
 * Debounce windows. Fixed, not configurable — the reference HA integration exposes no such
 * knob. A slider drag fires many intermediate values, so the setpoint window is the larger of
 * the two: it collapses the whole drag into a single send carrying only the final value.
 */
const COMMAND_DEBOUNCE_MS = 500
const SETPOINT_DEBOUNCE_MS = 1000

export interface CommandQueueOptions {
  rest: NeoRest
  serial: string
  log: Logging
  /** Test seam only — production always uses the constants above. */
  commandDebounceMs?: number
  setpointDebounceMs?: number
  /**
   * Backoff before each FanMode re-send during +CONT verification. Test seam —
   * defaults to `2**attempt` seconds, matching the reference HA integration.
   */
  fanModeVerifyBackoffMs?: (attempt: number) => number
}

const FAN_MODE_FIELD = 'UserAirconSettings.FanMode'

/** Re-reads and re-sends this many times if the FanMode set doesn't stick. */
const MAX_FAN_MODE_VERIFY_ATTEMPTS = 3

const SETPOINT_COMMANDS = new Set<string>([
  NeoCommand.COOL_SET_POINT,
  NeoCommand.HEAT_SET_POINT,
  NeoCommand.HEAT_COOL_SET_POINT,
  NeoCommand.ZONE_COOL_SET_POINT,
  NeoCommand.ZONE_HEAT_SET_POINT,
])

export class CommandQueue {
  private readonly debouncer: Debouncer
  private readonly commandDebounceMs: number
  private readonly setpointDebounceMs: number
  private readonly fanModeVerifyBackoffMs: (attempt: number) => number
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * Locally-tracked copy of UserAirconSettings.EnabledZones. Building zone commands from
   * this rather than re-reading cloud state per toggle is what stops rapid toggles from
   * clobbering each other.
   */
  private enabledZones: boolean[] = []

  /**
   * True from the moment the debounced 'zones' action starts running until its dispatch
   * settles. `Debouncer.flush` removes the pending entry *before* awaiting the action, so
   * `debouncer.isPending('zones')` alone has a window — after flush, before dispatch
   * completes — where a status poll's `syncEnabledZones` could clobber the in-flight toggle
   * with stale cloud state. This flag covers that window.
   */
  private zonesDispatching = false

  constructor(private readonly opts: CommandQueueOptions) {
    this.commandDebounceMs = opts.commandDebounceMs ?? COMMAND_DEBOUNCE_MS
    this.setpointDebounceMs = opts.setpointDebounceMs ?? SETPOINT_DEBOUNCE_MS
    this.debouncer = new Debouncer(this.commandDebounceMs)
    this.fanModeVerifyBackoffMs = opts.fanModeVerifyBackoffMs ?? (attempt => 2 ** attempt * 1000)
  }

  /** Shutdown: drop debounced commands instead of leaving their timers (and awaiting HomeKit setters) hanging. */
  cancelPending(): void {
    this.debouncer.cancelAll()
  }

  /** Seed from a status refresh, but never while a zone toggle is pending or dispatching. */
  syncEnabledZones(zones: boolean[]): void {
    if (this.debouncer.isPending('zones') || this.zonesDispatching) {
      this.opts.log.debug('Skipping EnabledZones reconcile; a zone toggle is still pending')
      return
    }
    this.enabledZones = [...zones]
  }

  static commandKey(command: NeoCommand, zoneIndex: number): string {
    switch (command) {
      case NeoCommand.ON:
      case NeoCommand.OFF:
        return 'power'
      // FAN_ONLY_ON shares this key on purpose: it *is* a mode change (carrying power with it),
      // so a thermostat mode picked in the same window must replace it wholesale, not race it.
      case NeoCommand.CLIMATE_MODE_AUTO:
      case NeoCommand.CLIMATE_MODE_COOL:
      case NeoCommand.CLIMATE_MODE_FAN:
      case NeoCommand.CLIMATE_MODE_HEAT:
      case NeoCommand.FAN_ONLY_ON:
        return 'climateMode'
      case NeoCommand.FAN_MODE_AUTO:
      case NeoCommand.FAN_MODE_AUTO_CONT:
      case NeoCommand.FAN_MODE_LOW:
      case NeoCommand.FAN_MODE_LOW_CONT:
      case NeoCommand.FAN_MODE_MEDIUM:
      case NeoCommand.FAN_MODE_MEDIUM_CONT:
      case NeoCommand.FAN_MODE_HIGH:
      case NeoCommand.FAN_MODE_HIGH_CONT:
        return 'fanMode'
      case NeoCommand.COOL_SET_POINT:
        return 'master:cool'
      case NeoCommand.HEAT_SET_POINT:
        return 'master:heat'
      case NeoCommand.HEAT_COOL_SET_POINT:
        return 'master:heatcool'
      case NeoCommand.AWAY_MODE_ON:
      case NeoCommand.AWAY_MODE_OFF:
        return 'awayMode'
      case NeoCommand.QUIET_MODE_ON:
      case NeoCommand.QUIET_MODE_OFF:
        return 'quietMode'
      case NeoCommand.CONTROL_ALL_ZONES_ON:
      case NeoCommand.CONTROL_ALL_ZONES_OFF:
        return 'controlAllZones'
      case NeoCommand.ZONE_ENABLE:
      case NeoCommand.ZONE_DISABLE:
        return 'zones'
      case NeoCommand.ZONE_COOL_SET_POINT:
        return `zone:${zoneIndex}:cool`
      case NeoCommand.ZONE_HEAT_SET_POINT:
        return `zone:${zoneIndex}:heat`
      // Each of the three settings coalesces independently — a duration drag must not
      // collapse into (or cancel) an enable/disable toggle, and vice versa.
      case NeoCommand.AFTER_HOURS_ON:
      case NeoCommand.AFTER_HOURS_OFF:
        return 'afterHoursEnabled'
      case NeoCommand.AFTER_HOURS_DURATION:
        return 'afterHoursDuration'
      case NeoCommand.TURBO_MODE_ON:
      case NeoCommand.TURBO_MODE_OFF:
        return 'turboMode'
      default:
        return String(command)
    }
  }

  async run(
    command: NeoCommand,
    { coolTemp = 20, heatTemp = 20, zoneIndex = 255, duration = 0 } = {},
  ): Promise<CommandResult> {
    // Apply zone intent locally before scheduling, so a burst across zones merges. A toggle
    // that arrives before the first syncEnabledZones must not leave sparse (`undefined`)
    // holes below zoneIndex — those would reach the SET_ENABLED_ZONES payload as-is.
    if (command === NeoCommand.ZONE_ENABLE || command === NeoCommand.ZONE_DISABLE) {
      while (this.enabledZones.length < zoneIndex)
        this.enabledZones.push(false)
      this.enabledZones[zoneIndex] = command === NeoCommand.ZONE_ENABLE
    }

    const key = CommandQueue.commandKey(command, zoneIndex)
    const delay = SETPOINT_COMMANDS.has(command)
      ? this.setpointDebounceMs
      : this.commandDebounceMs

    const action = command === NeoCommand.ZONE_ENABLE || command === NeoCommand.ZONE_DISABLE
      ? () => this.dispatchZones(command, coolTemp, heatTemp, zoneIndex, duration)
      : () => this.enqueue(() => this.dispatch(this.build(command, coolTemp, heatTemp, zoneIndex, duration)))

    return this.debouncer.schedule(key, action, delay)
  }

  /**
   * Wraps the zones dispatch with `zonesDispatching`, closing the race window described
   * on that field — see syncEnabledZones().
   */
  private async dispatchZones(command: NeoCommand, coolTemp: number, heatTemp: number, zoneIndex: number, duration: number): Promise<CommandResult> {
    this.zonesDispatching = true
    try {
      return await this.enqueue(() => this.dispatch(this.build(command, coolTemp, heatTemp, zoneIndex, duration)))
    }
    finally {
      this.zonesDispatching = false
    }
  }

  private build(command: NeoCommand, coolTemp: number, heatTemp: number, zoneIndex: number, duration: number) {
    if (command === NeoCommand.ZONE_ENABLE || command === NeoCommand.ZONE_DISABLE)
      return buildEnabledZones(this.enabledZones)
    return commandBuilders[command](coolTemp, heatTemp, zoneIndex, this.enabledZones, duration)
  }

  /** One command in flight at a time; a failure never wedges the chain for later tasks. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private async dispatch(body: { command: object }): Promise<CommandResult> {
    try {
      const response = await this.opts.rest.sendCommand(this.opts.serial, body)
      if (response.type !== 'ack') {
        // Same visibility as a transport error below — from the user's point of view both
        // mean the device did not adopt the change (README, "Command failures").
        this.opts.log.warn(`Command not acknowledged: ${JSON.stringify(body)}`)
        return CommandResult.FAILURE
      }

      // FanMode (including the +CONT continuous-fan flag) is known to sometimes ack
      // without the change actually landing. Verify it stuck against a fresh status read
      // rather than trusting the ack alone.
      const expectedFanMode = (body.command as Record<string, unknown>)[FAN_MODE_FIELD]
      if (typeof expectedFanMode === 'string')
        return await this.verifyFanMode(expectedFanMode, body)

      return CommandResult.SUCCESS
    }
    catch (error) {
      this.opts.log.warn(`Failed to send command: ${(error as Error).message}`)
      return CommandResult.API_ERROR
    }
  }

  /**
   * Confirms a FanMode set actually landed, re-sending and re-checking up to
   * `MAX_FAN_MODE_VERIFY_ATTEMPTS` times with increasing backoff. Runs entirely inside the
   * single-flight `chain` (called from `dispatch`) and talks to `rest` directly rather than
   * going back through `run()`/the debouncer, so a burst of newer commands on the `fanMode`
   * key queues behind this verification instead of coalescing with — or cancelling — it.
   */
  private async verifyFanMode(expected: string, body: { command: object }): Promise<CommandResult> {
    for (let attempt = 1; attempt <= MAX_FAN_MODE_VERIFY_ATTEMPTS; attempt++) {
      const status = await this.opts.rest.getStatus(this.opts.serial)
      const actual = status.lastKnownState.UserAirconSettings.FanMode
      if (actual === expected)
        return CommandResult.SUCCESS

      if (attempt === MAX_FAN_MODE_VERIFY_ATTEMPTS) {
        this.opts.log.warn(
          `FanMode did not stick after ${attempt} attempts: sent "${expected}", cloud reports "${actual}"`,
        )
        return CommandResult.FAILURE
      }

      this.opts.log.debug(`FanMode "${expected}" did not stick (cloud reports "${actual}"), retrying (${attempt}/${MAX_FAN_MODE_VERIFY_ATTEMPTS})`)
      await new Promise(r => setTimeout(r, this.fanModeVerifyBackoffMs(attempt)))
      await this.opts.rest.sendCommand(this.opts.serial, body)
    }

    /* istanbul ignore next -- loop always returns above */
    return CommandResult.FAILURE
  }
}

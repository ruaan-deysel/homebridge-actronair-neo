import { describe, expect, it, vi } from 'vitest'
import { CommandQueue } from '../src/neo/commands.js'
import { CommandResult, NeoCommand } from '../src/neo/types.js'

const logMocks = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const log = logMocks as never

function make(sendCommand = vi.fn(async () => ({ type: 'ack' }))) {
  const queue = new CommandQueue({
    rest: { sendCommand } as never,
    serial: 'neo000000',
    log,
    commandDebounceMs: 10,
    setpointDebounceMs: 20,
  })
  return { queue, sendCommand }
}

const fanStatus = (fanMode: string) => ({ lastKnownState: { UserAirconSettings: { FanMode: fanMode } } })

function makeWithFanVerify(fanModeSequence: string[], sendCommand = vi.fn(async () => ({ type: 'ack' }))) {
  let call = 0
  const getStatus = vi.fn(async () => fanStatus(fanModeSequence[Math.min(call++, fanModeSequence.length - 1)]))
  const queue = new CommandQueue({
    rest: { sendCommand, getStatus } as never,
    serial: 'neo000000',
    log,
    commandDebounceMs: 10,
    setpointDebounceMs: 20,
    fanModeVerifyBackoffMs: () => 0,
  })
  return { queue, sendCommand, getStatus }
}

describe('commandQueue', () => {
  it('groups related commands under one debounce key', () => {
    expect(CommandQueue.commandKey(NeoCommand.ON, 255)).toBe('power')
    expect(CommandQueue.commandKey(NeoCommand.OFF, 255)).toBe('power')
    expect(CommandQueue.commandKey(NeoCommand.FAN_MODE_HIGH_CONT, 255)).toBe('fanMode')
    expect(CommandQueue.commandKey(NeoCommand.ZONE_DISABLE, 3)).toBe('zones')
    expect(CommandQueue.commandKey(NeoCommand.ZONE_COOL_SET_POINT, 2)).toBe('zone:2:cool')
  })

  it('coalesces after-hours enable/disable and duration under independent keys', () => {
    expect(CommandQueue.commandKey(NeoCommand.AFTER_HOURS_ON, 255)).toBe('afterHoursEnabled')
    expect(CommandQueue.commandKey(NeoCommand.AFTER_HOURS_OFF, 255)).toBe('afterHoursEnabled')
    expect(CommandQueue.commandKey(NeoCommand.AFTER_HOURS_DURATION, 255)).toBe('afterHoursDuration')
    expect(CommandQueue.commandKey(NeoCommand.TURBO_MODE_ON, 255)).toBe('turboMode')
    expect(CommandQueue.commandKey(NeoCommand.TURBO_MODE_OFF, 255)).toBe('turboMode')
  })

  it('builds after-hours and turbo commands with the expected wire fields', async () => {
    const { queue, sendCommand } = make()
    await queue.run(NeoCommand.AFTER_HOURS_ON)
    await queue.run(NeoCommand.AFTER_HOURS_DURATION, { duration: 240 })
    await queue.run(NeoCommand.TURBO_MODE_ON)
    expect(sendCommand).toHaveBeenNthCalledWith(1, 'neo000000', { command: { 'UserAirconSettings.AfterHours.Enabled': true, 'type': 'set-settings' } })
    expect(sendCommand).toHaveBeenNthCalledWith(2, 'neo000000', { command: { 'UserAirconSettings.AfterHours.Duration': 240, 'type': 'set-settings' } })
    expect(sendCommand).toHaveBeenNthCalledWith(3, 'neo000000', { command: { 'UserAirconSettings.TurboMode.Enabled': true, 'type': 'set-settings' } })
  })

  it('coalesces a burst on one key into a single send', async () => {
    const { queue, sendCommand } = make()
    const results = await Promise.all([
      queue.run(NeoCommand.ON),
      queue.run(NeoCommand.OFF),
      queue.run(NeoCommand.ON),
    ])
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(results).toEqual([CommandResult.SUCCESS, CommandResult.SUCCESS, CommandResult.SUCCESS])
    expect(sendCommand.mock.calls[0][1]).toMatchObject({ command: { 'UserAirconSettings.isOn': true } })
  })

  it('merges concurrent zone toggles into one EnabledZones array', async () => {
    const { queue, sendCommand } = make()
    queue.syncEnabledZones([false, false, false, false])
    await Promise.all([
      queue.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 0 }),
      queue.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 2 }),
    ])
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(sendCommand.mock.calls[0][1]).toMatchObject({
      command: { 'UserAirconSettings.EnabledZones': [true, false, true, false] },
    })
  })

  it('does not reconcile zones while a toggle is pending', async () => {
    const { queue, sendCommand } = make()
    queue.syncEnabledZones([false, false])
    const pending = queue.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 1 })
    queue.syncEnabledZones([false, false])
    await pending
    expect(sendCommand.mock.calls[0][1]).toMatchObject({
      command: { 'UserAirconSettings.EnabledZones': [false, true] },
    })
  })

  it('does not leave sparse holes when a zone toggle arrives before the first sync', async () => {
    const { queue, sendCommand } = make()
    await queue.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 2 })
    expect(sendCommand.mock.calls[0][1]).toMatchObject({
      command: { 'UserAirconSettings.EnabledZones': [false, false, true] },
    })
  })

  it('does not reconcile zones while a toggle is dispatching, even after the debounce timer has fired', async () => {
    let releaseSend: (() => void) | undefined
    const sendCommand = vi.fn(() => new Promise((resolve) => {
      releaseSend = () => resolve({ type: 'ack' })
    }))
    const { queue } = make(sendCommand as never)
    queue.syncEnabledZones([false, false])
    const pending = queue.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 1 })

    // Wait for the debounce window to fire and dispatch to begin — by now Debouncer.flush
    // has already removed the 'zones' entry (isPending('zones') === false), but the
    // dispatch itself (sendCommand) has not resolved yet. A status poll's syncEnabledZones
    // landing in exactly this window is the race this test guards.
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalled())

    queue.syncEnabledZones([false, false])

    releaseSend!()
    await pending

    expect(sendCommand.mock.calls[0][1]).toMatchObject({
      command: { 'UserAirconSettings.EnabledZones': [false, true] },
    })
  })

  it('maps a non-ack response to FAILURE and warns, like a transport error', async () => {
    const { queue } = make(vi.fn(async () => ({ type: 'nack' })))
    logMocks.warn.mockClear()
    await expect(queue.run(NeoCommand.ON)).resolves.toBe(CommandResult.FAILURE)
    expect(logMocks.warn).toHaveBeenCalledWith(expect.stringMatching(/not acknowledged/i))
  })

  it('cancelPending() rejects debounced commands instead of leaving them hanging at shutdown', async () => {
    const { queue, sendCommand } = make()
    const pending = queue.run(NeoCommand.ON)
    queue.cancelPending()
    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('maps a transport error to API_ERROR and keeps the queue usable', async () => {
    const send = vi.fn(async () => {
      throw new Error('boom')
    })
    const { queue } = make(send)
    await expect(queue.run(NeoCommand.ON)).resolves.toBe(CommandResult.API_ERROR)
    await expect(queue.run(NeoCommand.OFF)).resolves.toBe(CommandResult.API_ERROR)
    expect(send).toHaveBeenCalledTimes(2)
  })

  describe('+CONT verification', () => {
    it('lands on the first check with no extra reads', async () => {
      const { queue, sendCommand, getStatus } = makeWithFanVerify(['MED+CONT'])
      await expect(queue.run(NeoCommand.FAN_MODE_MEDIUM_CONT)).resolves.toBe(CommandResult.SUCCESS)
      expect(sendCommand).toHaveBeenCalledTimes(1)
      expect(getStatus).toHaveBeenCalledTimes(1)
    })

    it('retries once when the flag drops, then succeeds', async () => {
      const { queue, sendCommand, getStatus } = makeWithFanVerify(['MED', 'MED+CONT'])
      await expect(queue.run(NeoCommand.FAN_MODE_MEDIUM_CONT)).resolves.toBe(CommandResult.SUCCESS)
      expect(sendCommand).toHaveBeenCalledTimes(2)
      expect(getStatus).toHaveBeenCalledTimes(2)
    })

    it('warns and reports FAILURE (never a false SUCCESS) if it never sticks', async () => {
      const { queue, sendCommand, getStatus } = makeWithFanVerify(['MED', 'MED', 'MED'])
      await expect(queue.run(NeoCommand.FAN_MODE_MEDIUM_CONT)).resolves.toBe(CommandResult.FAILURE)
      expect(getStatus).toHaveBeenCalledTimes(3)
      expect(sendCommand).toHaveBeenCalledTimes(3) // initial send + 2 resends
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('FanMode did not stick'))
    })

    it('does not verify commands with no FanMode field', async () => {
      const { queue, sendCommand, getStatus } = makeWithFanVerify(['irrelevant'])
      await expect(queue.run(NeoCommand.ON)).resolves.toBe(CommandResult.SUCCESS)
      expect(sendCommand).toHaveBeenCalledTimes(1)
      expect(getStatus).not.toHaveBeenCalled()
    })
  })
})

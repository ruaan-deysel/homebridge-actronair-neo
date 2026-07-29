import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Debouncer } from '../src/neo/debouncer.js'

describe('debouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('runs the action once after the quiet window', async () => {
    const debouncer = new Debouncer(500)
    const action = vi.fn().mockResolvedValue('done')

    const promise = debouncer.schedule('key', action)
    expect(action).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    await expect(promise).resolves.toBe('done')
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst on the same key into a single run of the latest action', async () => {
    const debouncer = new Debouncer(500)
    const first = vi.fn().mockResolvedValue(1)
    const second = vi.fn().mockResolvedValue(2)
    const third = vi.fn().mockResolvedValue(3)

    const p1 = debouncer.schedule('key', first)
    vi.advanceTimersByTime(200)
    const p2 = debouncer.schedule('key', second)
    vi.advanceTimersByTime(200)
    const p3 = debouncer.schedule('key', third)

    vi.advanceTimersByTime(500)
    await Promise.resolve()

    // Only the last action runs...
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(third).toHaveBeenCalledTimes(1)
    // ...and every caller shares its result.
    await expect(p1).resolves.toBe(3)
    await expect(p2).resolves.toBe(3)
    await expect(p3).resolves.toBe(3)
  })

  it('honours a per-call delay override', async () => {
    const debouncer = new Debouncer(500)
    const action = vi.fn().mockResolvedValue('done')

    const promise = debouncer.schedule('key', action, 200)

    vi.advanceTimersByTime(150)
    expect(action).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50) // reaches the 200ms override, not the 500ms default
    await expect(promise).resolves.toBe('done')
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct keys independent', async () => {
    const debouncer = new Debouncer(500)
    const a = vi.fn().mockResolvedValue('a')
    const b = vi.fn().mockResolvedValue('b')

    const pa = debouncer.schedule('a', a)
    const pb = debouncer.schedule('b', b)

    vi.advanceTimersByTime(500)
    await Promise.all([pa, pb])

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    await expect(pa).resolves.toBe('a')
    await expect(pb).resolves.toBe('b')
  })

  it('reports pending state and clears it after firing', async () => {
    const debouncer = new Debouncer(500)
    const promise = debouncer.schedule('key', vi.fn().mockResolvedValue(undefined))

    expect(debouncer.isPending('key')).toBe(true)
    expect(debouncer.isPending('other')).toBe(false)

    vi.advanceTimersByTime(500)
    await promise

    expect(debouncer.isPending('key')).toBe(false)
  })

  it('rejects the shared promise when the action throws, without wedging the key', async () => {
    const debouncer = new Debouncer(500)
    const failing = vi.fn().mockRejectedValue(new Error('boom'))

    const p1 = debouncer.schedule('key', failing)
    vi.advanceTimersByTime(500)
    await expect(p1).rejects.toThrow('boom')

    // The key is free again and can be rescheduled.
    expect(debouncer.isPending('key')).toBe(false)
    const ok = vi.fn().mockResolvedValue('ok')
    const p2 = debouncer.schedule('key', ok)
    vi.advanceTimersByTime(500)
    await expect(p2).resolves.toBe('ok')
  })

  it('flush runs the pending action immediately', async () => {
    const debouncer = new Debouncer(500)
    const action = vi.fn().mockResolvedValue('flushed')

    const promise = debouncer.schedule('key', action)
    await debouncer.flush('key')

    expect(action).toHaveBeenCalledTimes(1)
    await expect(promise).resolves.toBe('flushed')
    expect(debouncer.isPending('key')).toBe(false)
  })

  it('cancelAll rejects pending promises and clears timers', async () => {
    const debouncer = new Debouncer(500)
    const action = vi.fn().mockResolvedValue('never')
    const promise = debouncer.schedule('key', action)

    debouncer.cancelAll()

    await expect(promise).rejects.toThrow('cancelled')
    expect(debouncer.isPending('key')).toBe(false)
    vi.advanceTimersByTime(500)
    expect(action).not.toHaveBeenCalled()
  })
})

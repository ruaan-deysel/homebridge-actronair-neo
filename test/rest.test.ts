import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { NeoAuthRevokedError } from '../src/neo/auth.js'
import { NeoApiError, NeoRest } from '../src/neo/rest.js'

const restStatus = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

function make(fetchImpl: typeof fetch, invalidate = vi.fn()) {
  return {
    rest: new NeoRest({
      baseUrl: 'https://nimbus.actronair.com.au',
      auth: { getAccessToken: async () => 'tok', invalidate } as never,
      fetchImpl,
      log,
      retryDelayMs: 0,
    }),
    invalidate,
  }
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const status = (s: number) => new Response('{}', { status: s })

/**
 * Spies on setTimeout while firing callbacks immediately, so delay-bearing retry tests
 * assert the requested wait without actually waiting.
 */
function spyOnInstantSetTimeout() {
  return vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn()
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout)
}

describe('neoRest', () => {
  it('returns a parsed status response', async () => {
    const { rest } = make(vi.fn(async () => ok(restStatus)) as unknown as typeof fetch)
    const parsed = await rest.getStatus('neo000000')
    expect(parsed.lastKnownState.UserAirconSettings).toBeDefined()
  })

  it('refreshes once on 401 then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (++n === 1 ? status(401) : ok(restStatus))) as unknown as typeof fetch
    const { rest, invalidate } = make(fetchImpl)
    await expect(rest.getStatus('neo000000')).resolves.toBeDefined()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws when a second 401 follows the refresh', async () => {
    const fetchImpl = vi.fn(async () => status(401)) as unknown as typeof fetch
    const { rest, invalidate } = make(fetchImpl)
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoApiError)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('honours the one 401 refresh-and-retry even when it lands on the final 5xx attempt', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n++
      if (n <= 2)
        return status(503)
      if (n === 3)
        return status(401)
      return ok(restStatus)
    }) as unknown as typeof fetch
    const { rest, invalidate } = make(fetchImpl)
    await expect(rest.getStatus('neo000000')).resolves.toBeDefined()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('retries 5xx then throws NeoApiError', async () => {
    const fetchImpl = vi.fn(async () => status(503)) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoApiError)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('wraps network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoApiError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports the failing path on an invalid payload', async () => {
    const bad = structuredClone(restStatus)
    delete bad.lastKnownState.UserAirconSettings
    const { rest } = make(vi.fn(async () => ok(bad)) as unknown as typeof fetch)
    await expect(rest.getStatus('neo000000')).rejects.toThrow(/UserAirconSettings/)
  })

  it('wraps a malformed-JSON 200 body as NeoApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json{{{', { status: 200 })) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoApiError)
  })

  it('honours a numeric Retry-After on 429', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (++n === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }) : ok(restStatus))) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    const setTimeoutSpy = spyOnInstantSetTimeout()
    await expect(rest.getStatus('neo000000')).resolves.toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000)
    setTimeoutSpy.mockRestore()
  })

  it('honours an HTTP-date Retry-After on 429', async () => {
    let n = 0
    const retryAt = new Date(Date.now() + 10_000).toUTCString()
    const fetchImpl = vi.fn(async () => (++n === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': retryAt } }) : ok(restStatus))) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    const setTimeoutSpy = spyOnInstantSetTimeout()
    await expect(rest.getStatus('neo000000')).resolves.toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const waited = setTimeoutSpy.mock.calls[0][1] as number
    expect(waited).toBeGreaterThan(8000)
    expect(waited).toBeLessThanOrEqual(10_000)
    setTimeoutSpy.mockRestore()
  })

  it('falls back to the default retry delay when Retry-After is absent', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (++n === 1 ? new Response('{}', { status: 429 }) : ok(restStatus))) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    const setTimeoutSpy = spyOnInstantSetTimeout()
    await expect(rest.getStatus('neo000000')).resolves.toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0) // retryDelayMs: 0 in this test's rest
    setTimeoutSpy.mockRestore()
  })

  it('caps an absurd Retry-After at 60s and bounds 429 retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '86400' } })) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    const setTimeoutSpy = spyOnInstantSetTimeout()
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoApiError)
    // Bounded: 3 retries max, each capped at 60s -> worst case 180s wait, not 86400s.
    const delays = setTimeoutSpy.mock.calls.map(c => c[1])
    expect(delays).toEqual([60_000, 60_000, 60_000])
    expect(fetchImpl).toHaveBeenCalledTimes(4) // 1 initial + 3 capped retries, then give up
    setTimeoutSpy.mockRestore()
  })

  it('attaches an abort signal to every request so a hung connection cannot block forever', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal
      return ok(restStatus)
    }) as unknown as typeof fetch
    const { rest } = make(fetchImpl)
    await rest.getStatus('neo000000')
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('wraps an aborted (timed-out) request as NeoApiError, not a raw AbortError', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }) as unknown as typeof fetch
    const rest = new NeoRest({
      baseUrl: 'https://nimbus.actronair.com.au',
      auth: { getAccessToken: async () => 'tok', invalidate: vi.fn() } as never,
      fetchImpl,
      log,
      retryDelayMs: 0,
      timeoutMs: 5,
    })
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoApiError)
  })

  it('lets NeoAuthRevokedError escape unchanged rather than wrapping it', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const rest = new NeoRest({
      baseUrl: 'https://nimbus.actronair.com.au',
      auth: {
        getAccessToken: async () => { throw new NeoAuthRevokedError('grant revoked') },
        invalidate: vi.fn(),
      } as never,
      fetchImpl,
      log,
      retryDelayMs: 0,
    })
    await expect(rest.getStatus('neo000000')).rejects.toBeInstanceOf(NeoAuthRevokedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeoAuth, NeoAuthRevokedError } from '../src/neo/auth.js'

const BASE = 'https://nimbus.actronair.com.au'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeAuth(fetchImpl: typeof fetch) {
  return new NeoAuth({
    baseUrl: BASE,
    clientId: 'home_assistant',
    refreshToken: 'refresh-1',
    fetchImpl,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  })
}

describe('neoAuth', () => {
  it('requests a device code', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      device_code: 'dc',
      user_code: 'ABCD-EFGH',
      verification_uri: `${BASE}/connect`,
      verification_uri_complete: `${BASE}/connect?userCode=ABCD-EFGH`,
      interval: 5,
      expires_in: 1800,
    })) as unknown as typeof fetch

    const code = await makeAuth(fetchImpl).requestDeviceCode()
    expect(code.user_code).toBe('ABCD-EFGH')
    const body = (fetchImpl as never as ReturnType<typeof vi.fn>).mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_id')).toBe('home_assistant')
    expect(body.get('scope')).toBe('read write')
    // Sending grant_type on the device-code request returns an ASP.NET HTML error
    // page, not JSON, against the live API — it must never be sent here.
    expect(body.get('grant_type')).toBeNull()
  })

  it('attaches an abort signal to every token request so a hung connection cannot block forever', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal
      return jsonResponse({ access_token: 'at-1', expires_in: 3600 })
    }) as unknown as typeof fetch

    await makeAuth(fetchImpl).getAccessToken()
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('caches the access token until the renewal margin', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'at-1', expires_in: 3600 })) as unknown as typeof fetch
    const auth = makeAuth(fetchImpl)

    expect(await auth.getAccessToken()).toBe('at-1')
    expect(await auth.getAccessToken()).toBe('at-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refreshes once when several callers race past the margin', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: `at-${++n}`, expires_in: 3600 })) as unknown as typeof fetch
    const auth = makeAuth(fetchImpl)

    const [a, b, c] = await Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
    ])
    expect([a, b, c]).toEqual(['at-1', 'at-1', 'at-1'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws NeoAuthRevokedError when the grant is rejected', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch
    await expect(makeAuth(fetchImpl).getAccessToken()).rejects.toBeInstanceOf(NeoAuthRevokedError)
  })

  it('keeps polling through authorization_pending then succeeds', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return calls < 3
        ? jsonResponse({ error: 'authorization_pending' }, 400)
        : jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    }) as unknown as typeof fetch

    const auth = makeAuth(fetchImpl)
    const p = auth.pollForToken('dc', { intervalSeconds: 1, timeoutSeconds: 60 })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toMatchObject({ refresh_token: 'rt' })
  })

  it('widens the interval on slow_down', async () => {
    const callTimes: number[] = []
    const fetchImpl = vi.fn(async () => {
      callTimes.push(Date.now())
      return jsonResponse({ error: 'slow_down' }, 400)
    }) as unknown as typeof fetch

    const auth = makeAuth(fetchImpl)
    const p = auth.pollForToken('dc', { intervalSeconds: 1, timeoutSeconds: 60 })
    // eat the rejection this test doesn't care about; it only asserts on gap growth
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(40000)

    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i])
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < gaps.length; i++)
      expect(gaps[i]).toBeGreaterThan(gaps[i - 1])
  })

  it('gives up at the deadline instead of polling forever', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'authorization_pending' }, 400)) as unknown as typeof fetch

    const auth = makeAuth(fetchImpl)
    const p = auth.pollForToken('dc', { intervalSeconds: 1, timeoutSeconds: 10 })
    const assertion = expect(p).rejects.toThrow(/Timed out/)
    await vi.advanceTimersByTimeAsync(15000)
    await assertion
  })
})

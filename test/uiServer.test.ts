import { afterEach, describe, expect, it, vi } from 'vitest'

// The real HomebridgePluginUiServer base class calls process.exit(1) in its constructor
// when not run as an IPC child (which is always true under a test runner), and wires up
// IPC message handlers that don't apply here. Stub it so importing homebridge-ui/server.js
// exercises only the plugin's own request handlers.
vi.mock('@homebridge/plugin-ui-utils', () => ({
  HomebridgePluginUiServer: class {
    onRequest(): void {}
    ready(): void {}
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('homebridge-ui server', () => {
  it('attaches an abort signal to the token-exchange fetch so a hung connection cannot block the settings UI forever', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal
      return new Response(JSON.stringify({ device_code: 'dc' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)

    const { default: server } = await import('../homebridge-ui/server.js')
    await server.requestDeviceCode('client-1')

    expect(fetchImpl).toHaveBeenCalled()
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('attaches an abort signal to both account-lookup fetches', async () => {
    const seenSignals: (AbortSignal | undefined)[] = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignals.push(init.signal as AbortSignal | undefined)
      return new Response(JSON.stringify({ email: 'x@example.com', _embedded: { 'ac-system': [] } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)

    const { default: server } = await import('../homebridge-ui/server.js')
    await server.account({ accessToken: 'tok' })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(seenSignals).toHaveLength(2)
    for (const signal of seenSignals)
      expect(signal).toBeInstanceOf(AbortSignal)
  })
  it('surfaces a cloud failure instead of reporting an empty system list', async () => {
    // A 429/5xx (or an HTML error body) parses to `undefined._embedded`, which a bare `?? []`
    // turned into "✅ Linked as <email>" with an empty dropdown and nothing logged.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>rate limited</html>', { status: 429 })))

    const { default: server } = await import('../homebridge-ui/server.js')

    await expect(server.account({ accessToken: 'tok' })).rejects.toThrow(/could not reach the actronair cloud/i)
  })

  it('surfaces an unreadable 200 response rather than an empty system list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json</html>', { status: 200 })))

    const { default: server } = await import('../homebridge-ui/server.js')

    await expect(server.account({ accessToken: 'tok' })).rejects.toThrow(/unreadable/i)
  })
})

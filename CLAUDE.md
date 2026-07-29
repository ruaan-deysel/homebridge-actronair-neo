# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build           # rimraf ./dist && tsc
npm run lint            # eslint .
npm run lint:fix        # eslint . --fix
npm test                # vitest run
npm run test:watch      # vitest (watch mode)
npm run test:coverage   # vitest run --coverage -> coverage/
npx vitest run test/state.test.ts          # single file
npx vitest run -t 'name of test'           # single test by name
npm run watch            # build + npm link + nodemon (runs homebridge -I -D)
npm run prepublishOnly   # lint && test && build (also runs on `npm publish`)
```

Tests live in `test/`, not next to their source, and are named after the module they cover
(`test/state.test.ts` tests `src/neo/state.ts`). Fixtures are in `test/fixtures/`: real
(anonymised) API payloads — `ac-systems.json`, `rest-status.json` (a full `getStatus`
response), `full-status.json` and `status-change.json` (the two shapes MQTT pushes),
`connection-details.json` (broker connection info, `Port` as a string).

Linting is flat-config ESLint (`eslint.config.js`, `@antfu/eslint-config`) — there is no
`.eslintrc.json`.

Pushing to `main` triggers `.github/workflows/push.yml`: runs lint/test/build on Node 22.x
and 24.x, then bumps the version in `package.json`, tags, creates a GitHub release, and
publishes to npm. Don't hand-edit `version`.

## Architecture

A Homebridge dynamic platform plugin for ActronAir Neo HVAC, talking to the Neo cloud
(`https://nimbus.actronair.com.au`). Layers, outermost first:

1. **`src/index.ts`** registers `ActronAirNeoPlatform` (from `src/platform.ts`) under the
   `ActronAirNeo` platform name (`src/settings.ts`).
2. **`src/platform.ts`** — parses config (`src/config.ts`, Zod), discovers the account's
   system and zones, builds/updates/removes accessories, and owns the single poll loop.
3. **`src/neo/`** — the API layer: `auth.ts` (OAuth2), `rest.ts` (HTTP + retry), `state.ts`
   (`NeoState`, the authoritative state tree), `paths.ts` (dotted/bracketed path get/set),
   `commands.ts` (`CommandQueue`, debounce + serialise outgoing commands), `debouncer.ts`
   (generic keyed trailing-edge debounce), `schemas.ts` (Zod validation for every API
   response), `types.ts` (enums: `PowerState`, `ClimateMode`, `FanMode`, `NeoCommand`,
   `CommandResult`), `mqtt.ts` (`NeoMqtt`, the push transport — see mechanism 8 below),
   `certs.ts` (the MQTT broker's missing TLS intermediate).
4. **`src/accessories/`** — HAP bindings: `master.ts` (`MasterAccessory`, one Heater/Cooler
   + humidity sensor), `zone.ts` (`ZoneAccessory`, a Switch or, with `zonesAsHeaterCoolers`,
   its own Heater/Cooler + humidity + battery), `modeSwitch.ts` (`ModeSwitchAccessory`,
   shared by away/quiet/continuous-fan). All three read `platform.state` and write through
   `platform.commands`; none touch `NeoRest` directly.
5. **`homebridge-ui/`** — the custom settings page. `server.js` runs the OAuth2 device-code
   flow server-side (`/device-code`, `/poll-token`, `/session`, `/account`); `public/index.html`
   is the browser side that polls it and shows linked-account status.

`actron_api_documentation.md` documents the upstream cloud API.

### Mechanisms that are easy to break without knowing why they exist

1. **One platform-owned poll loop; accessories are event-driven, not timer-driven.**
   `platform.ts#startPolling` self-reschedules a single `setTimeout` (`poll()`) rather than a
   fixed `setInterval`, so the interval itself can widen/narrow between ticks (see mechanism
   8 — MQTT push health). Accessories subscribe to `NeoState.onChange`, updating only the
   HomeKit characteristics whose backing path is in the changed set (or `'*'` on a full
   replace). Polling and pushing blindly on every tick causes spurious HomeKit
   "characteristic value ignored" warnings when nothing actually changed, which is why
   updates are scoped to the paths that moved.

2. **`NeoState` (`src/neo/state.ts`) is the single authoritative tree.** `replace()` takes
   a full snapshot (a REST poll or an MQTT full-status). `applyDelta()`
   takes a flat map of dotted/bracket paths (`RemoteZoneInfo[0].LiveTemp_oC`) — the same
   notation Neo uses for both MQTT status-change deltas and outgoing commands, see
   `src/neo/paths.ts`. `applyDelta()` reports `ok: false` with the offending paths in
   `rejected` when a path it knows carries a value it cannot accept; callers must treat that
   as "resync from REST" rather than ignore it, or HomeKit drifts from the device with no
   error ever surfacing. A path the plugin simply doesn't read is different: it lands in
   `ignored`, leaves `ok` true, and triggers no resync — the cloud bundles fields we don't
   consume into the same broadcast as ones we do, so treating those as failures would discard
   every real update. Verified against live broker traffic; don't "tighten" it back.

3. **Command layer (`src/neo/commands.ts` + `debouncer.ts`).** Three things compose:
   - A keyed trailing-edge debounce (`Debouncer`) — a burst of calls under the same key (a
     slider drag, rapid toggles) collapses into a single outgoing command, and every caller
     that scheduled during the window shares the one resulting promise.
   - A serial dispatch chain (`CommandQueue.enqueue`) — one command in flight at a time, in
     order; a failed command must not wedge the chain for whatever comes after it.
   - A local `enabledZones` array, mutated synchronously on `ZONE_ENABLE`/`ZONE_DISABLE` and
     only turned into the wire `SET_ENABLED_ZONES`-style command at flush time from that
     merged array — so toggling two zones in quick succession doesn't have the second
     command overwrite the first's intent. `syncEnabledZones()` deliberately skips
     reconciling from a status poll while a zone toggle is still pending.

4. **Zod strategy: validate what you consume, pass the rest through (`src/neo/schemas.ts`).**
   Every schema is `z.looseObject`, listing only the fields the plugin actually reads —
   unknown upstream fields pass through untouched instead of failing validation. Numeric
   fields the API sometimes returns as strings (`ConnectionDetailsSchema.Port`, the
   `NV_Limits` setpoint/variance fields) use `z.coerce.number()`. This coercion is
   deliberate, not laziness: without it, one bad field fails the whole status parse and
   freezes every accessory on stale cached state until the next successful poll.

5. **Never unregister accessories on a failed discovery.** `platform.ts#discoverDevices`
   only calls `unregisterPlatformAccessories` inside `syncAccessories()`, which only runs
   after a discovery that genuinely succeeded (system found, status fetched) and then
   determined a device is genuinely gone. A caught error during discovery logs, keeps the
   existing accessories untouched, and just restarts the poll loop to retry later. Getting
   this backwards wipes the user's HomeKit rooms and automations, and that's unrecoverable
   for them.

6. **Zone setpoint limits come from the device's reported `NV_Limits.UserSetpoint_oC`**,
   not a hardcoded band (`src/accessories/zone.ts#resolveZoneSetpoint`). A variance
   (`VarianceAboveMasterCool` etc.) is honoured only when non-zero — zero, or the field
   being absent, means "no constraint relative to the master" for that firmware. When
   a zone value falls outside the permitted variance, the master setpoint is nudged rather
   than the zone value being clamped. A fixed ±2°C band is a plausible-sounding
   rule that some documentation elsewhere describes; it is not what the device reports, so
   don't introduce it.

7. **Auth (`src/neo/auth.ts`) is OAuth2 device-code flow.** Only a non-rotating refresh
   token is persisted, and it lives in the plugin's `config.json` (written by the
   `homebridge-ui` settings page), not in a token file. Access tokens are minted on demand
   and kept in memory only (`NeoAuth`), with concurrent callers sharing one in-flight
   refresh. The access token also doubles as the MQTT password (`src/neo/mqtt.ts`), which is
   why `getAccessToken()`/`invalidate()` are shaped as a small reusable surface — `invalidate()`
   is called both after a REST 401 and after the broker rejects a CONNACK, so either transport
   forces the next attempt to fetch a genuinely fresh token rather than trusting a stale cache.

8. **MQTT push (`src/neo/mqtt.ts`) overlays the REST poll loop, it never replaces it.**
   Every failure — broker discovery, TLS, a rejected CONNACK, a malformed payload, a lost
   connection — is caught, logged and backed off (0.5s → ×2 → 60s cap, reset on a successful
   connect), never thrown. `platform.ts` widens its poll interval to a 5-minute safety-net
   cadence while `NeoMqtt.healthy` and snaps back to `refreshInterval` the instant it isn't,
   driven by `NeoMqtt`'s `onHealthChange` callback rather than waiting for the next poll tick.
   Client id is a **fresh random id with `clean: true` on every connect**, not a persisted
   stable one — matching the repo owner's own working Home Assistant integration against this
   same broker, which commented that there's no session worth resuming and a persistent
   session just leaves orphans on the broker, while a stable id can collide with itself across
   a container restart because brokers evict whichever client already holds it. The TLS chain: the broker
   serves a genuine `*.actronair.com.au` cert but omits the intermediate and is dialled by IP,
   so `src/neo/certs.ts` supplies the missing intermediate (appended to
   `tls.rootCertificates`, never replacing it) and `servername` is set to a covered hostname —
   `rejectUnauthorized` stays `true` throughout.

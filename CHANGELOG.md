# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-07-29

### Fixed

- HomeKit no longer logs "supplied illegal value" for the master setpoints or the After Hours
  duration on every startup. These characteristics begin at a HAP default below the range the
  plugin sets from the device's own limits, so the stored value was rejected until something
  wrote a valid one. They are now seeded at startup, and the setpoint getters clamp into the
  device's range instead of falling back to a value outside it.
- Zone names are trimmed to what HAP accepts. A name entered in the ActronAir app with a
  trailing space — invisible there — made HomeKit warn that the accessory "may not be added in
  the Home App or cause unresponsiveness". Existing accessories are corrected in place, keeping
  their room, scenes and automations, and every service name is reconciled rather than only the
  accessory's own.

### Security

- Both workflows declare least-privilege `permissions` instead of inheriting repository-wide
  scopes, and the path-write helper's prototype-pollution guard is now explicit at the write
  itself. Behaviour is unchanged; the guard was previously expressed in a form static analysis
  could not follow.

## [1.0.0] - 2026-07-29

First release of **homebridge-actronair-neo**.

### Added

**Accessories**

- Master controller as a Heater/Cooler accessory: mode, fan speed, target temperature,
  current temperature and humidity.
- Each zone as an on/off switch, with its own temperature and humidity sensors. Turning on
  **Enable zone control** instead gives every zone a full accessory with independent
  setpoints.
- Wireless zone sensors report their real battery level, signal strength and connection
  state. Wired sensors get no battery service at all, rather than a permanent fake 100%.
- Away mode, Quiet mode, Continuous fan and Turbo mode switches.
- After Hours as a Valve accessory, so its run duration is adjustable from the Home app.
- Outdoor temperature sensor, shown only when the system reports a usable reading — not
  when the value is absent, out of range, or the unit is reporting a sensor fault.

**Automatic model detection**

- The plugin reads your unit's reported capabilities at startup and exposes only what it
  actually supports: the fan slider offers just the speeds your indoor unit reports, and
  switches for unsupported features are never created. The detected model and capabilities
  are logged once at startup.
- Firmware on some units under-reports its own fan speeds while actively running one. The
  speed currently in use is always included, so it can't disappear from the slider. An
  unrecognised or missing capability list falls back to a working Low/Medium/High set.
- Temperature limits come from the device's own reported range, falling back to built-in
  bounds only when the system reports none.

**Setup**

- Account linking by OAuth2 device code, from a custom page in the Homebridge settings UI:
  it shows a short code and a link, waits for approval, then confirms the linked account and
  the system it found. Your ActronAir password is never entered into Homebridge.
- Accounts with more than one system get a picker; single-system accounts are configured
  automatically.
- The plugin registers no accessories until an account is linked, and says so in the log.
- The settings page distinguishes a revoked link (re-link) from an unreachable cloud (retry),
  instead of reporting both the same way.

**Live updates**

- State arrives over the ActronAir cloud's MQTT feed in about a second, instead of waiting
  for the next poll. Push is always on.
- REST polling always runs underneath as a safety net — it never turns off, only slows down
  while push is healthy, and returns to the configured interval the moment push goes stale or
  drops. Every reconnect resyncs from REST.
- Every push failure — broker discovery, TLS, a rejected connection, a malformed payload, a
  dropped socket — is logged and retried with exponential backoff, and never interrupts
  polling. An expired token is refreshed and retried rather than ending push for the session.
- All accessories share one in-memory state tree, so they stay consistent with each other and
  update only the values that actually changed.

**Reliability**

- A failed discovery never unregisters cached accessories. Only a discovery that succeeds and
  genuinely omits a device removes it, so a cloud outage cannot wipe your HomeKit rooms,
  scenes and automations.
- Cloud rate limiting is respected: the plugin honours `Retry-After`, capped so a hostile or
  broken value cannot park it indefinitely. Server errors are retried, and an expired token is
  refreshed and the request retried once.
- Absent numeric readings from the cloud are treated as missing rather than failing the whole
  status update — one dropped zone sensor can't freeze every accessory on stale state.
- The continuous-fan flag is sometimes acknowledged by the cloud without being applied. The
  plugin re-reads status after setting a fan mode and retries, rather than letting a switch
  claim a state the unit isn't in.
- Commands the cloud doesn't acknowledge surface as failures in HomeKit instead of silently
  appearing to work. Rapid changes (such as dragging a temperature slider) are coalesced into
  a single command.

### Security

- No password is stored anywhere. Only a non-rotating refresh token is persisted; access
  tokens are held in memory only.
- MQTT connections verify the full TLS certificate chain. The broker omits its intermediate
  certificate and is addressed by IP; the plugin supplies the intermediate and sets the
  expected hostname rather than disabling verification.
- Third-party GitHub Actions are pinned to immutable commit SHAs, since the release workflow
  holds write access and a publish token.
- Test fixtures are scrubbed of real account identifiers, system serials and zone names.

### Requirements

- Homebridge 2.x, and Node.js 22 or 24.
- An ActronAir Neo account with at least one registered system. Accounts are linked from the
  plugin settings page; there is no username or password setting, and nothing to configure by
  hand.

[1.0.1]: https://github.com/ruaan-deysel/homebridge-actronair-neo/releases/tag/v1.0.1
[1.0.0]: https://github.com/ruaan-deysel/homebridge-actronair-neo/releases/tag/v1.0.0

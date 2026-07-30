# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-30

### Added

- **Filter status.** The unit's own `Alerts.CleanFilter` is exposed as a FilterMaintenance
  service on the main accessory — HomeKit's own service for exactly this, so the Home app shows
  the filter alert the ActronAir controller raises (its error log records E103, "Return Air Fan
  Filter requires cleaning"). No reset button: the cloud API has no documented filter reset, and
  a button that silently does nothing is worse than none. A unit that reports no filter alert at
  all reads as OK rather than nagging about a filter nobody has been told about.
- **The Fan tile reports whether air is actually moving** (`CurrentFanState`), not just whether
  fan-only is selected — the unit can sit in FAN mode between cycles, and during spin-up.
- **Sensor staleness and faults.** The main humidity sensor and the outdoor temperature sensor
  now carry `StatusActive`, the signal zone sensors already had: both serve their last known
  reading when the controller stops reporting, and until now nothing distinguished that from a
  live value. The outdoor sensor also reports `StatusFault` when the unit says its ambient
  sensor has failed (`AmbientSensErr`) — which is what that characteristic means, and why a
  system-wide error code is deliberately not reported through it.

### Fixed

- **An optional part of the status tree appearing or disappearing wholesale no longer leaves
  characteristics stuck on their previous value.** The change detector could not describe such a
  transition below the subtree itself, so it reported only the parent path — while every
  accessory watches the leaf beneath it. Filter status, the outdoor sensor's fault and staleness
  flags, After Hours and Turbo were all affected. Leaf paths are now reported too, so a leaf
  watcher is correct without every accessory having to watch each ancestor as well.
- The outdoor temperature sensor no longer reports a communication failure after a reading goes
  bad when a perfectly good one was in state moments earlier. Its last-known-good value was only
  ever recorded by a read, so if HomeKit hadn't yet asked, there was nothing to fall back to; it
  is now seeded at startup. Its status characteristics are also pushed before the temperature,
  which can throw — otherwise the very characteristics that explain the failure were skipped.

## [1.1.0] - 2026-07-30

### Added

- **Fan-only mode is now reachable from HomeKit.** The ActronAir app offers Cool, Heat, Fan and
  Auto, but HomeKit's Heater/Cooler has no fan-only target state, so `Fan` was the one mode the
  plugin could not select. Units reporting `ModeSupport.Fan` now get a Fan service on the master
  accessory: switching it on puts the system in fan-only mode (powering it up if it was off, in a
  single atomic power+mode command so a mode picked in the same debounce window can't split it),
  switching it off powers the system down, and its speed slider is the same fan speed as the
  thermostat's. A unit that does not report fan support gets no Fan service, and a cached one is
  removed. The tile carries its own `ConfiguredName` ("&lt;name&gt; Fan"), which is what the Home app
  actually reads for a service since iOS 16 — with only `Name` set it would appear as a second
  tile identical to the thermostat's. It is seeded once and never re-applied, so renaming the fan
  in the Home app sticks across restarts.
- Climate modes are now part of the detected capabilities and are logged at startup alongside
  the model and fan speeds.

### Fixed

- The thermostat only offers the modes the unit reports supporting
  (`UserAirconSettings.ModeSupport`). Previously Cool, Heat and Auto were always offered, so on
  a unit lacking one of them the mode could be picked in the Home app and the resulting command
  was acknowledged by the cloud and ignored by the hardware.
- A system left in fan-only mode from the ActronAir app no longer reports a mode it isn't in.
  The thermostat reported Auto (and logged a "Failed To Get Master Target Climate Mode"
  debug line) because `FAN` matched none of its cases; it now holds its last real heat/cool/auto
  target while the new Fan service carries the actual state, and never reports a mode HomeKit
  was told to expect. Zone accessories in **Enable zone control** mode hold their target the same
  way instead of flattening fan-only to Auto, so a zone tile no longer contradicts the master's.
- The platform accessory's name from `config.json` is trimmed to what HAP accepts, the same way
  zone names already were. It now seeds a second characteristic (the fan's `ConfiguredName`), so a
  stray leading/trailing space would have produced two HAP warnings instead of none.
- A service whose name an accessory derives from the accessory's own ("ActronAir Neo Fan") is no
  longer reconciled away to the bare accessory name, which would have left two identically-named
  tiles in the Home app. The exemption is limited to the accessory that owns such a service, so a
  genuinely stale name — including one left over from a longer previous name — is still corrected.

### Notes

- Dry/dehumidify mode is still not exposed. No unit seen so far reports `ModeSupport.Dry` as
  true, and HomeKit would need a separate Dehumidifier service for it.

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

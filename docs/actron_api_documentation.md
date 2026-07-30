# ActronAir Neo (Nimbus) API Cheat Sheet

How this plugin authenticates with, queries, commands and subscribes to the ActronAir Neo
cloud.

The details here were established by observing live traffic against a real ActronAir Neo
account and system, and they match what `src/neo/` implements. This is not published,
validated or endorsed by ActronAir, and is provided without warranty of any kind. Endpoints
and payload shapes can change without notice.

All requests go to `https://nimbus.actronair.com.au`.

## Authentication

Neo uses the OAuth2 **device authorisation flow** (RFC 8628). There is no username/password
API call — the user authorises on ActronAir's own site, and the client only ever sees tokens.

Three steps: request a device code, poll until the user approves, then exchange the resulting
refresh token for access tokens as needed.

`client_id` is `home_assistant`. At the time of writing that is the only value observed to
work; there is no plugin-specific client id.

### 1. Request a device code

**Request**
Method: POST
Path: `/api/v0/oauth/token`
Headers: `Content-Type: application/x-www-form-urlencoded`

Body:

```
client_id: home_assistant
scope:     read write
```

**Response**

```json
{
  "device_code": "<opaque>",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://nimbus.actronair.com.au/activate",
  "verification_uri_complete": "https://nimbus.actronair.com.au/activate?user_code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

Show `user_code` to the user and send them to `verification_uri_complete` (or
`verification_uri`, where they enter the code by hand).

### 2. Poll for approval

Poll no faster than `interval` seconds, until `expires_in` elapses.

**Request**
Method: POST
Path: `/api/v0/oauth/token`
Headers: `Content-Type: application/x-www-form-urlencoded`

Body:

```
client_id:   home_assistant
grant_type:  urn:ietf:params:oauth:grant-type:device_code
device_code: <device_code from step 1>
```

**Response while waiting** — HTTP 4xx with an OAuth2 error code:

- `authorization_pending` — keep polling.
- `slow_down` — keep polling, but increase the interval.
- anything else (`access_denied`, `expired_token`, …) — terminal, start over.

**Response once approved** — HTTP 200:

```json
{
  "access_token": "<long value>",
  "refresh_token": "<long value>",
  "token_type": "bearer",
  "expires_in": 259199
}
```

Persist the `refresh_token`. Do not persist the access token.

### 3. Refresh an access token

**Request**
Method: POST
Path: `/api/v0/oauth/token`
Headers: `Content-Type: application/x-www-form-urlencoded`

Body:

```
client_id:     home_assistant
grant_type:    refresh_token
refresh_token: <stored refresh token>
```

**Response**

```json
{
  "access_token": "<long value>",
  "token_type": "bearer",
  "expires_in": 259199
}
```

Notable: **the refresh token does not rotate.** This call returns only a new `access_token`,
so the stored refresh token is written once at link time and never rewritten. A revoked or
expired grant fails here — that is the signal to prompt the user to re-link.

Send the access token as `Authorization: Bearer <access_token>` on every subsequent call. It
is also the MQTT password (see [Live updates](#live-updates-over-mqtt)).

## Queries

Method: GET, empty body, `Authorization: Bearer <access_token>`. All return JSON.

### Account

`/api/v0/client/account`

Returns the signed-in account, including `email` — useful for showing which account is linked.

### List AC systems

`/api/v0/client/ac-systems?includeNeo=true`

Systems are under `_embedded["ac-system"]`, each with `serial` and `description` (the
user-facing name). The serial is required as a query parameter by every call below.

`includeNeo=true` matters — without it, Neo systems may not be listed.

### System status

`/api/v0/client/ac-systems/status/latest?serial=<serial>`

The full state tree: settings, live readings, zones, capabilities and peripherals. The device
state is nested under **`lastKnownState`** (see [Payload envelopes](#payload-envelopes)).

### System events

`/api/v0/client/ac-systems/events/latest?serial=<serial>`

Paging, replacing `|` in an event id with `%`:

```
/api/v0/client/ac-systems/events/newer?serial=<serial>&newerThanEventId=<event_id>
/api/v0/client/ac-systems/events/older?serial=<serial>&olderThanEventId=<event_id>
```

This plugin does not use the events endpoints; state comes from status plus MQTT.

## Commands

Method: POST
Path: `/api/v0/client/ac-systems/cmds/send?serial=<serial>`
Headers: `Authorization: Bearer <access_token>`, `Content-Type: application/json`

Every command is a flat map of dotted/bracketed paths plus a `type`:

```json
{
  "command": {
    "<path>": "<value>",
    "type": "set-settings"
  }
}
```

Multiple paths can be set in one command, and doing so is preferable to firing several —
related settings then apply together.

A 200 response means the cloud accepted the command, **not** that the unit applied it. See
[Quirks](#quirks-worth-knowing) for where that distinction bites.

### Power and mode

```json
{ "command": { "UserAirconSettings.isOn": false, "type": "set-settings" } }
```

```json
{
  "command": {
    "UserAirconSettings.isOn": true,
    "UserAirconSettings.Mode": "COOL",
    "type": "set-settings"
  }
}
```

`Mode` is one of `AUTO`, `COOL`, `HEAT`, `FAN`. Power can be set on its own or together with a
mode.

### Fan mode

```json
{ "command": { "UserAirconSettings.FanMode": "MED", "type": "set-settings" } }
```

`FanMode` is `AUTO`, `LOW`, `MED` or `HIGH`. Continuous fan appends **`+CONT`** (a plus, not a
hyphen): `AUTO+CONT`, `LOW+CONT`, `MED+CONT`, `HIGH+CONT`.

Which speeds a unit actually supports is a per-model capability — see
[Capabilities](#capabilities).

### Master setpoint

Setpoints are floating point, in °C, and only meaningful outside `OFF` and `FAN` modes.

```json
{ "command": { "UserAirconSettings.TemperatureSetpoint_Cool_oC": 20.5, "type": "set-settings" } }
```

```json
{ "command": { "UserAirconSettings.TemperatureSetpoint_Heat_oC": 22.0, "type": "set-settings" } }
```

In `AUTO`, set both in one command.

### Zones

Zones are zero-indexed. Enabled zones are sent as the **whole array**, which avoids two rapid
toggles racing each other:

```json
{
  "command": {
    "UserAirconSettings.EnabledZones": [true, false, false, true, false, false, false, false],
    "type": "set-settings"
  }
}
```

Per-zone setpoints:

```json
{
  "command": {
    "RemoteZoneInfo[2].TemperatureSetpoint_Cool_oC": 20.5,
    "RemoteZoneInfo[2].TemperatureSetpoint_Heat_oC": 22.0,
    "type": "set-settings"
  }
}
```

Zone setpoints may be constrained relative to the master setpoint — see
[Setpoint limits](#setpoint-limits).

### Other settings

Each of these is a single command; the paths are boolean unless noted.

| Setting | Path |
| --- | --- |
| Away mode | `UserAirconSettings.AwayMode` |
| Quiet mode | `UserAirconSettings.QuietMode` |
| Turbo mode | `UserAirconSettings.TurboMode.Enabled` |
| Control all zones | `MasterInfo.ControlAllZones` |
| After Hours | `UserAirconSettings.AfterHours.Enabled` |
| After Hours duration | `UserAirconSettings.AfterHours.Duration` (minutes) |

```json
{
  "command": {
    "UserAirconSettings.AfterHours.Enabled": true,
    "UserAirconSettings.AfterHours.Duration": 120,
    "type": "set-settings"
  }
}
```

## Live updates over MQTT

Rather than polling for changes, the cloud will push them. Push is an overlay: keep polling as
a safety net, because any part of this can fail.

### Broker connection details

`GET /api/v0/messaging/connection/details`

```json
{ "Endpoint": "<ipv4>", "Port": "8883", "Protocol": "TLS", "UserId": "<uuid>" }
```

Note the **PascalCase** keys, and that `Port` is a **string**, not a number.

### Connecting

- `username`: empty string. `password`: the OAuth **access token**.
- MQTT 3.1.1, keepalive 60.
- A **fresh random client id with `clean: true` on every connect.** There is no session worth
  resuming — every message is either a snapshot or covered by a REST resync — and a stable id
  can collide with itself across a restart, since brokers evict whichever client already holds
  it.
- The access token expires. A rejected connection means fetch a fresh token and retry, not
  give up.

**TLS is the fiddly part.** The broker presents a genuine `*.actronair.com.au` certificate but
**omits the intermediate**, and `Endpoint` is a bare IPv4 address. Both are solvable without
weakening verification:

- Supply the missing intermediate yourself, **appended to** the system trust store. Passing it
  as the sole `ca` replaces the trust store rather than adding to it.
- Set the TLS servername (SNI) to a hostname the certificate covers, since you are dialling by
  IP.
- Leave certificate verification enabled.

### Topics

With `UserId` from the connection details and the serial **lower-cased**:

```
actron-cloud/<UserId>/neo/<serial>/mwc/full-status
actron-cloud/<UserId>/neo/<serial>/mwc/status-change
actron-cloud/<UserId>/neo/<serial>/mwc/heart-beat
actron-cloud/<UserId>/neo/<serial>/mwc/cmd-response/+/+
```

`heart-beat` is a liveness signal — a connected socket that has stopped producing heartbeats
should be treated as stale and the poll interval tightened again.

### Payload envelopes

The three sources nest device state differently, and conflating them is an easy mistake:

| Source | Device state lives at |
| --- | --- |
| REST status | `lastKnownState` |
| MQTT `full-status` | `event` |
| MQTT `status-change` | `event`, as flat dotted paths |

A `full-status` payload is a whole snapshot. A `status-change` payload is a delta keyed by the
same dotted/bracketed notation used for commands:

```json
{
  "event": {
    "type": "status-change-broadcast",
    "RemoteZoneInfo[1].ZonePosition": 5,
    "LiveAircon.OutdoorUnit.RoomTemp": 23.8,
    "MasterInfo.LiveHumidity_pc": 53.8
  }
}
```

Observed deltas are **leaf-valued** — including collections, which arrive as indexed leaves
(`UserAirconSettings.EnabledZones[0]` … `[7]`) rather than a whole array.

**The cloud freely mixes fields you care about with fields you don't, in one message.** The
example above carries a humidity reading this plugin uses alongside two fields it ignores.
Treating an unrecognised path as an error and discarding the whole delta therefore throws away
real updates — it makes push strictly worse than polling. Ignore what you don't consume;
reserve failure for a path you *do* consume carrying a value you can't accept, and resync from
REST when that happens.

## Field notes

### Capabilities

The status tree describes what the unit supports. Reading these rather than assuming keeps a
client working across models:

- `AirconSystem.MasterWCModel`, `.IndoorUnit.NV_DeviceID`, `.OutdoorUnit.Family` — model
  identification.
- `AirconSystem.IndoorUnit.NV_SupportedFanModes` — a **bitmap**: `1=LOW`, `2=MED`, `4=HIGH`,
  `8=AUTO`. Absent, zero or unparseable is best treated as low/medium/high rather than no fan
  at all.
- `AirconSystem.IndoorUnit.NV_AutoFanEnabled` — AUTO needs both the bit and this flag.
- `UserAirconSettings.ModeSupport` — `{ Cool, Heat, Fan, Auto, Dry }` booleans, the same list
  the app's Mode picker is built from. A real NTW-1000 reports all but `Dry`. Older firmware
  omits the object entirely, in which case the four long-standing modes are the safe
  assumption and `Dry` is not.
- `UserAirconSettings.TurboMode.Supported`, `.QuietMode` support, VFT flags — feature gates.

Firmware on at least one real unit reports `NV_SupportedFanModes: 3` (LOW+MED) while running
`FanMode: "HIGH"`. Union the currently-running speed into the supported set, or a speed in
active use disappears from your UI.

### Setpoint limits

`NV_Limits.UserSetpoint_oC` carries the absolute range (`setCool_Min`/`setCool_Max`,
`setHeat_Min`/`setHeat_Max`) and per-mode variance fields describing how far a zone setpoint
may sit from the master.

A variance of **0** — or an absent field — means *no constraint*, not "must match". Some
systems report all zeroes. There is no fixed ±2 °C rule.

### Zone sensors

`RemoteZoneInfo[i].Sensors` is keyed by sensor id. Each entry's `NV_Kind` identifies the
hardware:

- `"ZS: <serial>"` — a **wireless** sensor. Join that serial to
  `AirconSystem.Peripherals[].SerialNumber` for `RemainingBatteryCapacity_pc`, `RSSI` and
  `ConnectionState`.
- A designator such as `"C1"` — a **wired** sensor, which has no battery at all.

Battery level lives on the peripheral, not on the zone.

### Absent values

Numeric fields are not reliably numeric. The cloud uses:

- `"NA"` for a reading that is unavailable — common on a sensor that has dropped out.
- `3000` as a "no reading" sentinel on some temperatures.
- Strings for some numbers (`Port`, several `NV_Limits` fields).

Parse defensively. Treating `"NA"` as a parse failure will fail the *entire* status update,
freezing every value on stale data because one sensor went quiet.

## Quirks worth knowing

- **A 200 is an acknowledgement, not an application.** The continuous-fan flag in particular is
  sometimes accepted and then not applied. Re-read status after setting a fan mode and retry
  rather than trusting the ack.
- **Out-of-range setpoints are silently clamped.** Send a value outside the device's reported
  limits and the cloud accepts it, then applies something else. Nothing errors — so resolve
  limits from `NV_Limits` rather than offering a range the unit will quietly override.
- **Rate limiting is real.** `429 Too Many Requests` comes back with `Retry-After`. Honour it,
  but cap it: a large value would otherwise park a client for hours.

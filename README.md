# Homebridge ActronAir Neo

[![npm](https://img.shields.io/npm/v/homebridge-actronair-neo/latest?label=latest)](https://www.npmjs.com/package/homebridge-actronair-neo)
[![GitHub release](https://img.shields.io/github/release/ruaan-deysel/homebridge-actronair-neo.svg)](https://github.com/ruaan-deysel/homebridge-actronair-neo/releases)
[![npm](https://img.shields.io/npm/dt/homebridge-actronair-neo)](https://www.npmjs.com/package/homebridge-actronair-neo)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Control your ActronAir Neo air conditioning system with Apple HomeKit using Homebridge.

## Table of Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [License](#license)
- [Support](#support)

## What it does

The plugin exposes an ActronAir Neo system as HomeKit accessories through Homebridge:

- The master controller as a Heater/Cooler accessory, reporting and setting mode, fan
  speed, temperature and humidity.
- The filter alert as a Filter service on the same accessory, so the Home app tells you when
  the controller wants the return-air filter cleaned.
- Fan-only mode as a Fan on the same accessory, when your unit supports it. HomeKit's
  thermostat has no fan-only setting of its own (it offers Off, Cool, Heat and Auto only), so
  the Fan is how you reach the ActronAir app's **Fan** mode. Turning it on switches the system
  to fan-only — turning it off switches the system off, because in fan-only mode the fan *is*
  the system running. Its speed slider is the same fan speed as the thermostat's.
- Each configured zone, either as a simple on/off switch (default) or, with **Enable zone
  control** turned on, as its own accessory with independent temperature setpoints.
- Away mode, Quiet mode, Continuous fan and Turbo mode as individual switches (each only
  when your unit reports support for it).
- After Hours as a Valve accessory, with its run duration adjustable from the Home app.
  This is the ActronAir controller's run-on timer: switch it on and the system runs for the
  configured duration (30 minutes to 8 hours, the range the controller accepts) and then
  stops, instead of running until something turns it off. It is a Valve because that is
  HomeKit's "on for a set duration" accessory — the duration is under *Show Details* in the
  Home app. It does not change temperature, fan speed or zones, and it is unrelated to
  schedules.
- The outdoor temperature as its own sensor, when your system reports a usable reading.

Accessories are updated from the ActronAir cloud's live MQTT feed (~1 s) with REST polling
running underneath as a safety net, through a single shared in-memory state tree — so all
accessories stay consistent with each other without each one polling the cloud
independently.

The plugin auto-detects your ActronAir model and its reported capabilities on startup
(climate modes, fan speeds, Turbo, VFT, Quiet mode, outdoor temperature sensor) and only exposes the
accessories and options your unit actually supports — for example, the fan speed slider
only offers the speeds your indoor unit reports, and switches for unsupported features
simply aren't created. The detected model and capabilities are logged once at startup.

## Requirements

- Homebridge 2.x
- Node.js 22 or 24
- An ActronAir Neo account with at least one registered system

## Installation

1. Search for "ActronAir Neo" on the Plugins screen of Homebridge Config UI X.
2. Install `homebridge-actronair-neo`.
3. Open the plugin settings and link your account (see [Configuration](#configuration)).

## Configuration

Everything is configured from the plugin settings page in Homebridge Config UI X. There is
nothing to edit by hand.

**Link your account first.** Open the plugin settings and choose **Link ActronAir account**.
The page shows a short code and a link to ActronAir's site — sign in there, enter the code,
and the page confirms the linked account and the system it found. Your ActronAir password is
never entered into Homebridge, and only a refresh token is stored. If your account has more
than one system, a **System** dropdown appears so you can pick the one to control.

The plugin does not start until an account is linked. Everything else it can work out on its
own: your model, its capabilities, and the accessories to expose. That leaves three settings:

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable zone control** | Off | Give each zone its own accessory with independent temperature setpoints, instead of an on/off switch. Needs a system that supports per-zone setpoints. |
| **Refresh Interval (seconds)** | 60 | How often to poll the ActronAir cloud. Live push updates arrive in about a second regardless; polling is the safety net beneath them, and backs off automatically while push is healthy. |
| **Enable Debug Logging** | Off | Log this plugin's request, command and coalescing detail at info level, without running all of Homebridge in debug mode. |

## Troubleshooting

1. **Plugin logs "account is not linked" and no accessories appear.** Open the plugin
   settings and link your account — see [Configuration](#configuration).
2. **Settings page says the account link is no longer valid.** The link was revoked (for
   example, the authorised device was removed in the ActronAir app) or expired. Choose
   **Re-link account** on the same page.
3. **Settings page says it couldn't reach the ActronAir cloud.** Your link is still saved;
   this is usually a network blip. Choose **Try again**.
4. **HTTP 5xx errors in the log.** These are server-side errors from the ActronAir cloud.
   The plugin retries automatically; if they persist, it's a temporary problem with the
   ActronAir service itself.
5. **Multiple systems on one account, wrong one is controlled.** Pick the right one from the
   **System** dropdown on the settings page.

## License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file
for details.

## Support

If you encounter any issues or have feature requests, please
[open an issue](https://github.com/ruaan-deysel/homebridge-actronair-neo/issues) on
GitHub.

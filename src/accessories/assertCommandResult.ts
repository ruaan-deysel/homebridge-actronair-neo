import type { ActronAirNeoPlatform } from '../platform.js'
import { HAPStatus } from 'homebridge'
import { CommandResult } from '../neo/types.js'

/**
 * Both API_ERROR (transport failure — request never reached the cloud, or the response
 * couldn't be read) and FAILURE (the cloud responded but didn't ack, or a value that was
 * sent never stuck) mean one thing from HomeKit's point of view: the device did not adopt
 * the change. Silently resolving the HAP setter in either case would show the write as
 * successful while state quietly goes stale — worse than a visible error, since the user
 * has no signal to retry. Both are treated the same and surfaced as a communication
 * failure; there is no user-actionable difference between "couldn't reach the cloud" and
 * "cloud said no" that would justify swallowing one of them.
 */
export function assertCommandSuccess(platform: ActronAirNeoPlatform, result: CommandResult): void {
  if (result !== CommandResult.SUCCESS)
    throw new platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
}

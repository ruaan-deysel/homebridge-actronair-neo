import type { API } from 'homebridge'
import { ActronAirNeoPlatform } from './platform.js'
import { PLATFORM_NAME } from './settings.js'

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, ActronAirNeoPlatform)
}

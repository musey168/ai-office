import { installSecureContextPolyfills } from './polyfill'

/**
 * The entry the server injects into **every** page, before the bridge.
 *
 * It is a separate script because not every upstream preload pulls in the
 * Electron shim — and the polyfill has to be there for the apps whose
 * preload does not.
 */
installSecureContextPolyfills()

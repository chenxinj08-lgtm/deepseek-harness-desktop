/** Package-owned invariant companion for @deepseek-ai/dsh-host-vision. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-vision'
/** Cordis companion plugin name. */
export const name = 'host-vision-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: the observer tool fails closed on malformed vision output. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

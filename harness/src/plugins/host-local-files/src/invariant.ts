/** Package-owned invariant companion for @deepseek-ai/dsh-host-local-files. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-local-files'
/** Cordis companion plugin name. */
export const name = 'host-local-files-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: webserver owns route registration symmetry; files become visible only after atomic metadata commit. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

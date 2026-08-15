/** Package-owned invariant companion for @deepseek-ai/dsh-client-ui-local-files. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-local-files'
/** Cordis companion plugin name. */
export const name = 'client-ui-local-files-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: input-source and slot registration symmetry is owned by their registries. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

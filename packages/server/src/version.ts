/** Set by the bundlers (packages/tlpt/build.mjs, sea.mjs) from packages/tlpt/package.json, the one
 *  place tlpt's version is written; 'dev' when run from source. */
declare const TLPT_VERSION: string | undefined;

export const VERSION = typeof TLPT_VERSION === 'string' ? TLPT_VERSION : 'dev';

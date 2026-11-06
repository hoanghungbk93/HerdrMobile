import pkg from '../package.json' with { type: 'json' };

/** The bridge's own version, bundled into the compiled binary from package.json. */
export const VERSION: string = pkg.version;

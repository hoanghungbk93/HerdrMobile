import os from 'node:os';
import path from 'node:path';

export const HERDR_BIN = process.env.HERDR_BIN || 'herdr';
export const DATA_DIR = process.env.HERDR_MOBILE_HOME || path.join(os.homedir(), '.herdr-mobile');
/** herdr socket protocol version this bridge was developed and tested against. */
export const TESTED_PROTOCOL = 22;

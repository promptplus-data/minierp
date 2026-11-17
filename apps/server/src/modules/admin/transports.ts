/** Outbound transports of the admin module, replaceable in tests (no network in the test suite). */
import { defaultAdapters, type AdapterFactory } from './backup';

export const transports: { backup: AdapterFactory } = { backup: defaultAdapters };

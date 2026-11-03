/** Outbound transports of the admin module, replaceable in tests (no network in the test suite). */
import { defaultAdapters, type AdapterFactory } from './backup';
import { httpSender, type Sender } from './share';

export const transports: { share: Sender; backup: AdapterFactory } = { share: httpSender, backup: defaultAdapters };

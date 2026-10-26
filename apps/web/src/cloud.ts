/**
 * Cloud-only UI, loaded lazily. Every reference sits behind the static `import.meta.env.VITE_EDITION === 'cloud'`
 * test, which Vite replaces with a literal, so the on-prem build drops these branches and never emits the chunks
 * under ./promptplus/ (scripts/check-onprem.mjs fails the build otherwise). Do not import ./promptplus/* anywhere else.
 */
import { lazy } from 'react';

export const IS_CLOUD = import.meta.env.VITE_EDITION === 'cloud';

export const CloudSsoButton = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./promptplus/SsoButton')) : null;
export const CloudIncomingCard = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./promptplus/IncomingCard')) : null;
export const CloudReorderButton = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./promptplus/ReorderButton')) : null;

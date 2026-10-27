/**
 * Module registry: every module group's Fastify plugin, registered by buildApp() after the core routes.
 * Each plugin is encapsulated (its decorators and hooks stay inside it); routes share the app's error handler,
 * auth and not-found handling. Module agents edit only their own modules/<name>/ folder, not this file.
 */
import type { FastifyInstance } from 'fastify';
import { adminModule } from './admin';
import { purchasingModule } from './purchasing';
import { reportsModule } from './reports';
import { retailModule } from './retail';
import { salesModule } from './sales';
import type { ErpModule, ModuleOptions } from './types';

export const MODULES: readonly { name: string; plugin: ErpModule }[] = [
  { name: 'sales', plugin: salesModule },
  { name: 'purchasing', plugin: purchasingModule },
  { name: 'retail', plugin: retailModule },
  { name: 'admin', plugin: adminModule },
  { name: 'reports', plugin: reportsModule },
];

export async function registerModules(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  for (const m of MODULES) await app.register(m.plugin, opts);
}

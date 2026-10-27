/** Column helpers shared by every schema file (conventions in packages/db/MIGRATIONS.md). */
import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();
export const tenantId = () => uuid('tenant_id').notNull();
export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
export const qty = (name: string) => numeric(name, { precision: 14, scale: 4 });
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

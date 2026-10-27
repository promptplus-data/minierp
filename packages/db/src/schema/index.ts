/**
 * Drizzle schema, re-exported as `schema` from @erp/db. One file per module group so parallel work never touches
 * the same file: core (phase 1), sales, purchasing, retail, admin, reports. Edit only your module's file.
 */
export * from './core';
export * from './sales';
export * from './purchasing';
export * from './retail';
export * from './admin';
export * from './reports';

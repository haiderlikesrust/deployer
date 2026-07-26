/**
 * Barrel. `ui.tsx` stays the single import path so pages can be migrated one at
 * a time — every symbol the old file exported is still exported here, with
 * signatures that are supersets of the originals.
 */
export * from './index';

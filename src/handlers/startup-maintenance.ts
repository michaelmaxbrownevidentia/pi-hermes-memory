import { measureLifecycle, measureLifecycleSync } from '../lifecycle-timing.js';
import { DEFAULT_SESSION_RETENTION_DAYS } from '../constants.js';
import type { DatabaseManager } from '../store/db.js';
import { runRecoveryMaintenance } from '../store/recovery-maintenance.js';
import { pruneEphemeralReviewSessions, pruneExpiredSessionText } from '../store/session-indexer.js';
import type { MemoryConfig } from '../types.js';

export const STARTUP_MAINTENANCE_SHUTDOWN_TIMEOUT_MS = 5000;
/** Bounds per-startup retention work; a large backlog drains over several starts. */
export const STARTUP_MAINTENANCE_MAX_RETENTION_BATCHES = 5;

type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface StartupMaintenanceOptions {
  dbManager: DatabaseManager;
  config: MemoryConfig;
  globalDir: string;
  warn?: (message: string) => void;
  setTimeoutFn?: SetTimeoutFn;
}

const state: { promise: Promise<void> | null; stopping: boolean } = { promise: null, stopping: false };

function isBusy(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return code.startsWith('SQLITE_BUSY') || /database is locked/i.test(describe(err));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Housekeeping that used to be awaited inside session_start: ephemeral review
 * cleanup, session-text retention and the snapshot sweep. It now runs after
 * session_start resolves, yields between steps, and stops early on shutdown,
 * so it can never hold up the first prompt.
 */
export function scheduleStartupMaintenance(options: StartupMaintenanceOptions): Promise<void> {
  if (state.promise) return state.promise;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const yieldToPi = () => new Promise<void>((resolve) => { setTimeoutFn(resolve, 0); });
  const retentionDays = options.config.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS;
  state.stopping = false;

  const run = async () => {
    await yieldToPi();
    if (state.stopping) return;
    try {
      pruneEphemeralReviewSessions(options.dbManager);
    } catch (err) {
      warn(`⚠️ Ephemeral session cleanup failed: ${describe(err)}`);
    }

    for (let batch = 0; batch < STARTUP_MAINTENANCE_MAX_RETENTION_BATCHES; batch++) {
      await yieldToPi();
      if (state.stopping) return;
      let pruned: number;
      try {
        pruned = measureLifecycleSync('maintenance.session-retention', () => pruneExpiredSessionText(options.dbManager, retentionDays));
      } catch (err) {
        // Another Pi holds the write lock: leave the backlog for a later start.
        if (!isBusy(err)) warn(`⚠️ Session retention failed: ${describe(err)}`);
        break;
      }
      if (pruned === 0) break;
    }

    await yieldToPi();
    if (state.stopping) return;
    try {
      await measureLifecycle('maintenance.recovery-sweep', () => runRecoveryMaintenance({
        config: options.config,
        globalDir: options.globalDir,
      }));
    } catch (err) {
      warn(`⚠️ Snapshot retention sweep failed: ${describe(err)}`);
    }
  };

  const promise = run().finally(() => {
    if (state.promise === promise) state.promise = null;
  });
  state.promise = promise;
  return promise;
}

/** Ask maintenance to stop at its next step and wait briefly before the DB closes. */
export async function waitForStartupMaintenance(timeoutMs: number): Promise<void> {
  state.stopping = true;
  const pending = state.promise;
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

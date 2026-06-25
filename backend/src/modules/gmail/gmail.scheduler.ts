import { getAllGmailAccounts } from "./gmail.repository.js";
import { syncGmailAccount } from "./gmail.sync.service.js";
import { GMAIL_SYNC_INTERVAL_MS } from "../../shared/constants/config.js";

// Guards against overlapping runs when a sync cycle outlasts the interval.
let isRunning = false;
let timer: NodeJS.Timeout | null = null;

const runSyncCycle = async (): Promise<void> => {
  if (isRunning) {
    console.warn("[gmail-scheduler] Previous run still in progress, skipping");
    return;
  }

  isRunning = true;

  try {
    const accounts = await getAllGmailAccounts();

    console.log(
      `[gmail-scheduler] Run started, ${accounts.length} account(s) to sync`,
    );

    let succeeded = 0;
    let failed = 0;

    // Sequential so one account's failure never aborts the others.
    for (const account of accounts) {
      try {
        const result = await syncGmailAccount(account);

        succeeded += 1;

        console.log("[gmail-scheduler] Account synced", {
          email: account.email,
          mode: result.mode,
          totalFetched: result.totalFetched,
          processed: result.stats.processed,
          duplicates: result.stats.duplicates,
          queued: result.stats.queued,
          failed: result.stats.failed,
          latestHistoryId: result.latestHistoryId,
        });
      } catch (error) {
        failed += 1;

        console.error(
          `[gmail-scheduler] Failed to sync account ${account.email}`,
          error,
        );
      }
    }

    console.log(
      `[gmail-scheduler] Run finished, ${succeeded} succeeded, ${failed} failed`,
    );
  } catch (error) {
    // e.g. the account fetch itself failed; never let it crash the interval.
    console.error("[gmail-scheduler] Run failed", error);
  } finally {
    isRunning = false;
  }
};

export const startGmailScheduler = (): void => {
  if (timer) {
    console.warn("[gmail-scheduler] Already started, ignoring duplicate start");
    return;
  }

  console.log(
    `[gmail-scheduler] Starting, interval ${GMAIL_SYNC_INTERVAL_MS}ms`,
  );

  // Fire one cycle immediately, then on every interval.
  void runSyncCycle();

  timer = setInterval(() => {
    void runSyncCycle();
  }, GMAIL_SYNC_INTERVAL_MS);
};

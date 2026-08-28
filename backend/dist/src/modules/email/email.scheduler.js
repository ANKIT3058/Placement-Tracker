import { reconcilePendingEmails } from "./email.reconciler.js";
import { EMAIL_RECONCILE_INTERVAL_MS, EMAIL_RECONCILE_MIN_AGE_MS, } from "../../shared/constants/config.js";
/* Periodic recovery of Emails that were persisted but never queued (F-3e).
 *
 * Deliberately a SEPARATE scheduler from the Gmail one, with its own timer and
 * its own running flag. `runSyncCycle` clears its guard in a `finally`, and a
 * `finally` runs when its `try` completes or throws — neither of which happens
 * when an await never settles. So one stalled Gmail request leaves that flag
 * set for the life of the process and every later Gmail cycle short-circuits
 * (F-2b). Sharing it would mean a stalled Gmail request also stops orphan
 * recovery, and the failure that CREATES orphans — Redis being unreachable
 * during ingestion — is exactly the kind of degraded moment when the rest of
 * the system is least healthy. Recovery must not depend on the component most
 * likely to be broken.
 *
 * Nothing here stops the timer, matching `startGmailScheduler`. The repository
 * has no shutdown convention — no SIGTERM handler, no stop function anywhere —
 * and inventing one for this single timer would add a lifecycle abstraction the
 * codebase does not otherwise have. An interrupted sweep is harmless: the rows
 * it had not reached are still `pending`, and the next boot finds them.
 */
// Guards against overlapping sweeps when one cycle outlasts the interval.
let isRunning = false;
let timer = null;
const runReconcileCycle = async () => {
    if (isRunning) {
        console.warn("[email-reconciler] Previous sweep still in progress, skipping");
        return;
    }
    isRunning = true;
    try {
        // Recomputed every cycle from the current clock. Capturing it once at
        // startup would leave the cutoff fixed while time moved on, so it would
        // stop meaning "older than the configured age" for the cycle actually
        // being run.
        const olderThan = new Date(Date.now() - EMAIL_RECONCILE_MIN_AGE_MS);
        const { enqueued } = await reconcilePendingEmails({ olderThan });
        // Logged only when there was something to recover. In steady state an
        // orphan requires a failed enqueue to exist at all, so a quiet sweep is the
        // normal case and announcing it every interval would bury the times it
        // mattered.
        if (enqueued > 0) {
            console.log("[email-reconciler] Recovered unqueued emails", { enqueued });
        }
    }
    catch (error) {
        // Survive, but visibly. The interval must keep firing — a sweep that failed
        // because the database blinked cannot be allowed to disable recovery until
        // the next deploy — and an operator still has to be able to tell that
        // recovery is not running.
        console.error("[email-reconciler] Sweep failed", error instanceof Error ? error.message : "Unknown error");
    }
    finally {
        isRunning = false;
    }
};
export const startEmailReconciliationScheduler = () => {
    if (timer) {
        console.warn("[email-reconciler] Already started, ignoring duplicate start");
        return;
    }
    console.log(`[email-reconciler] Starting, interval ${EMAIL_RECONCILE_INTERVAL_MS}ms`);
    // Fire one sweep immediately, then on every interval. An email orphaned
    // before a restart should not have to wait a full interval to be recovered.
    void runReconcileCycle();
    timer = setInterval(() => {
        void runReconcileCycle();
    }, EMAIL_RECONCILE_INTERVAL_MS);
};
//# sourceMappingURL=email.scheduler.js.map
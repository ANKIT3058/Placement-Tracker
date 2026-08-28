import { reconcileOrphanedAttachments } from "./attachment.reconciler.js";
import { ATTACHMENT_RECONCILE_INTERVAL_MS, ATTACHMENT_RECONCILE_MIN_AGE_MS, ATTACHMENT_RECONCILE_BATCH_SIZE, } from "../../shared/constants/config.js";
/* Periodic recovery of attachments whose durable state says the pipeline is
 * unfinished but which no BullMQ job represents (G-7.3).
 *
 * Deliberately a SEPARATE scheduler from the email one, with its own timer and
 * its own running flag — the same separation, for the same reason, that keeps
 * email reconciliation off the Gmail scheduler's flag. A sweep that stalls must
 * not be able to stop an unrelated one, and the conditions that strand
 * attachment work are exactly the degraded moments when the rest of the system
 * is least healthy.
 *
 * Nothing here stops the timer, matching `startGmailScheduler` and
 * `startEmailReconciliationScheduler`. The API process has no shutdown
 * convention for background loops, and inventing one for this single timer
 * would add a lifecycle abstraction the codebase does not otherwise have. An
 * interrupted sweep is harmless: the rows it had not reached are untouched —
 * the reconciler writes nothing — so the next boot finds them exactly as they
 * were.
 */
// Guards against overlapping sweeps when one cycle outlasts the interval.
let isRunning = false;
let timer = null;
const runReconcileCycle = async () => {
    if (isRunning) {
        console.warn("[attachment-reconciler] Previous sweep still in progress, skipping");
        return;
    }
    isRunning = true;
    try {
        // Recomputed every cycle from the current clock. Capturing it once at
        // startup would leave the cutoff fixed while time moved on, so it would
        // stop meaning "older than the configured age" for the cycle actually
        // being run.
        const olderThan = new Date(Date.now() - ATTACHMENT_RECONCILE_MIN_AGE_MS);
        const { enqueued } = await reconcileOrphanedAttachments({
            olderThan,
            batchSize: ATTACHMENT_RECONCILE_BATCH_SIZE,
        });
        // Logged only when there was something to recover. The predicate
        // over-selects on purpose, so most sweeps enqueue nothing that was actually
        // stranded, and announcing every interval would bury the times it mattered.
        if (enqueued > 0) {
            console.log("[attachment-reconciler] Recovered stranded attachments", {
                enqueued,
            });
        }
    }
    catch (error) {
        // Survive, but visibly. The interval must keep firing — a sweep that failed
        // because the database blinked cannot be allowed to disable recovery until
        // the next deploy — and an operator still has to be able to tell that
        // recovery is not running.
        //
        // A failed sweep enqueues nothing, which is the direction this must fail
        // in: the row list is the reconciler's only input, so an unavailable
        // database or queue produces no work rather than a duplicate-work storm.
        console.error("[attachment-reconciler] Sweep failed", error instanceof Error ? error.message : "Unknown error");
    }
    finally {
        isRunning = false;
    }
};
export const startAttachmentReconciliationScheduler = () => {
    if (timer) {
        console.warn("[attachment-reconciler] Already started, ignoring duplicate start");
        return;
    }
    console.log(`[attachment-reconciler] Starting, interval ${ATTACHMENT_RECONCILE_INTERVAL_MS}ms`);
    // Fire one sweep immediately, then on every interval. An attachment stranded
    // before a restart should not have to wait a full interval to be recovered.
    void runReconcileCycle();
    timer = setInterval(() => {
        void runReconcileCycle();
    }, ATTACHMENT_RECONCILE_INTERVAL_MS);
};
//# sourceMappingURL=attachment.scheduler.js.map
import { getStaleUnfinishedAttachments } from "./attachment.repository.js";
import { enqueueAttachmentProcessing } from "./attachment.queue.js";
import { parserRegistry } from "./parsers/parser-registry.js";
/* Recovers attachment work that PostgreSQL still owes and BullMQ no longer
 * represents (G-7.3).
 *
 * THE STATE THIS EXISTS FOR. An attachment row can say the pipeline is
 * unfinished while no job exists for `attachment-${id}`:
 *
 *   - the enqueue never ran. `processEmailJob` commits the Email and then
 *     enqueues; the two stores share no transaction, so a Redis outage leaves
 *     rows with no job behind them.
 *   - Redis lost the job. A restart without persistence, or an eviction policy
 *     that reaches the job hashes, empties the queue while every row survives.
 *   - the job COMPLETED on a half-finished pipeline. This is the G-7.1 window:
 *     `markAttachmentCompleted` commits after the download and before the
 *     parse, so a worker killed mid-parse leaves a row reading `completed` with
 *     nothing parsed. `removeOnComplete: true` then deleted the job. Nothing
 *     else can reach that row — the normal enqueue filter
 *     (`getPendingAttachmentsByEmailId`) excludes `completed` — which is why
 *     this is the case the reconciler was written for.
 *
 * THE GUARANTEE IS AT-LEAST-ONCE RECOVERY WITH CONVERGENT EFFECTS, never
 * exactly-once — that is not achievable across Postgres and Redis and is not
 * claimed here. Convergence comes from three places that already exist:
 * `isSettled` makes a replay resume instead of restart, `updateParsedResult`
 * overwrites in place, and `saveDocumentIntelligence` upserts on
 * `@@unique([attachmentId, userId])`. Two non-idempotent effects survive a
 * duplicate run and are accepted: a replay stores the file under a fresh UUID,
 * orphaning the previous one, and it repeats the Document Intelligence call
 * when `USE_AI=true`.
 *
 * DELIBERATELY BLIND TO REDIS. No `getJob`, no `getJobCounts`, no
 * check-then-enqueue: the deterministic `jobId: attachment-${id}` is the
 * concurrency authority, and BullMQ resolves the race inside `add` itself — an
 * existing job hash makes the call a no-op. Asking Redis first would race the
 * exact window the check was meant to close, and would put a second, weaker
 * answer beside the one the queue already enforces.
 *
 * WRITES NOTHING. `processingStatus`, `parsedAt` and `parsingError` belong to
 * the worker; a second writer would make that lifecycle ambiguous. A row this
 * function fails to enqueue is left exactly as it was, so it stays eligible for
 * the next sweep — the only durable record that the work is still owed.
 */
export const reconcileOrphanedAttachments = async ({ olderThan, batchSize, }) => {
    // The cutoff and the bound are the caller's, never computed here. How long to
    // wait before treating an attachment as stranded, and how much to take in one
    // pass, are deployment decisions; this function should not be the place that
    // decides them.
    //
    // A rejection propagates on purpose. Failing the whole sweep means ZERO
    // enqueues, which is the correct direction to fail in: the row list is the
    // only input, so no rows can never become "enqueue everything". The
    // scheduler's outer boundary logs it and the interval keeps running.
    const candidates = await getStaleUnfinishedAttachments(olderThan, batchSize);
    let enqueued = 0;
    // Sequential, with a per-row catch, matching how every other background loop
    // in this codebase treats a batch: one row's failure never aborts the rest.
    for (const attachment of candidates) {
        // THE FILTER THAT KEEPS THIS FROM BECOMING A CHURN LOOP.
        //
        // `completed` + both parse columns NULL is also the durable signature of a
        // successfully downloaded attachment whose MIME type has no parser — a row
        // `isSettled` already considers finished. Enqueueing it would produce a job
        // the worker immediately no-ops, which then completes, which frees the
        // deterministic id, which makes the row eligible again on the very next
        // sweep: unbounded churn, forever, growing with the corpus.
        //
        // The registry answers this, and nothing else may: it is the single
        // authority on MIME-to-parser routing (see parser-registry), so a MIME list
        // in the recovery query would be a second one, free to drift.
        if (parserRegistry.findParser(attachment.mimeType) === undefined) {
            continue;
        }
        try {
            // Through the normal producer, so the job name, options and deterministic
            // id stay defined in exactly one place. A second `queue.add` here would
            // be free to drift from it — and the payload stays `{ attachmentId }`,
            // carrying no owner: a queue is not an authenticated channel, so the
            // worker derives the owner from the persisted row instead (RFC-001 §9.5).
            await enqueueAttachmentProcessing(attachment.id);
            enqueued += 1;
        }
        catch (error) {
            // Counted as failure, not success, and the row is left untouched on
            // purpose: it stays eligible for the next pass. Marking it processed here
            // would erase the only evidence that the work is still owed.
            //
            // Safe scalars only, and never the error object itself (RFC-001 §13.2).
            // This path sits beside a pipeline that handles Gmail credentials and
            // document contents; an error is a bag, and `message` is the one field
            // whose contents are predictable enough to publish. The filename and
            // anything parsed from the document are deliberately absent.
            console.error(`[attachment-reconciler] Failed to enqueue attachment ${attachment.id}`, error instanceof Error ? error.message : "Unknown error");
        }
    }
    return { enqueued };
};
//# sourceMappingURL=attachment.reconciler.js.map
import { prisma } from "../../lib/prisma.js";
import { createEvent } from "./event.repository.js";
import { generateEventKey } from "./event.utils.js";
import { toUTCDate, toISTKey } from "../../shared/utils/date.js";
// CREATE
export const createEventService = async (data) => {
    const eventKey = generateEventKey({
        company: data.company,
        stage: data.stage,
        date: data.date,
    });
    return createEvent(data, eventKey);
};
// UPDATE
export const updateEventService = async (eventId, existing, incoming) => {
    // MANUAL AUTHORITY (AC-3 / D-9).
    //
    // A human decision is the highest authority in the system, and `confirmed` is
    // the state that records one. Automated inference may not revise a confirmed
    // Event at all — not even when its confidence is equal or higher.
    //
    // The guard is on status rather than on the confidence comparison below,
    // because authority is categorical and confidence is a quantity. Manual
    // confirmation sets confidence to exactly 1.0, and a maximally-confident
    // extraction also reaches 1.0, so the incumbent comparator cannot tell "a
    // person settled this" apart from "the extractor was very sure". Tightening
    // that comparator to `<=` would express the same intent as a numeric
    // coincidence and would additionally reject equal-confidence automated
    // updates between two inferences, which is unrelated behaviour. It is left
    // untouched.
    //
    // This is the only automated write path to an Event, so this is the only
    // place the guard is needed. `updateEventManuallyService` is the human path
    // and is deliberately not affected.
    if (existing.status === "confirmed") {
        console.log("Skipping update: event is confirmed by a human");
        return existing;
    }
    const { changes, isRescheduled } = detectChanges(existing, incoming);
    if (changes.length === 0) {
        return existing;
    }
    const existingConfidence = existing.confidence ?? 0;
    const newConfidence = incoming.confidence ?? 0;
    console.log("UPDATE CHECK:", {
        existing: existingConfidence,
        incoming: newConfidence,
    });
    // CORE RULE
    if (newConfidence < existingConfidence) {
        console.log("Skipping update due to lower confidence");
        return existing; // stop update
    }
    // Prepare update data
    const updateData = {};
    if (changes.some((c) => c.field === "date")) {
        updateData.date = toUTCDate(incoming.date);
    }
    if (changes.some((c) => c.field === "time")) {
        updateData.time = incoming.time;
    }
    if (changes.some((c) => c.field === "venue")) {
        updateData.venue = incoming.venueMeta?.isExplicit
            ? incoming.venueMeta.value
            : (incoming.venue ?? null);
    }
    // RESCHEDULE LOGIC
    if (isRescheduled) {
        updateData.status = "rescheduled";
        updateData.eventKey = generateEventKey({
            company: existing.company,
            stage: existing.stage,
            date: incoming.date,
        });
    }
    return prisma.$transaction(async (tx) => {
        // Store change history
        for (const change of changes) {
            await tx.eventUpdate.create({
                data: {
                    eventId,
                    field: change.field,
                    oldValue: change.oldValue,
                    newValue: change.newValue,
                },
            });
        }
        // Update event
        return tx.event.update({
            where: {
                id: eventId,
            },
            data: {
                ...updateData,
                confidence: newConfidence,
            },
        });
    });
};
export const detectChanges = (existing, incoming) => {
    const changes = [];
    let isRescheduled = false;
    // DATE
    const existingDateKey = toISTKey(existing.date);
    const incomingDateKey = toISTKey(toUTCDate(incoming.date));
    if (existingDateKey !== incomingDateKey) {
        changes.push({
            field: "date",
            oldValue: existingDateKey,
            newValue: incomingDateKey,
        });
        isRescheduled = true;
    }
    // TIME
    if (incoming.time !== undefined &&
        incoming.time !== null &&
        existing.time !== incoming.time) {
        changes.push({
            field: "time",
            oldValue: existing.time || "null",
            newValue: incoming.time || "null",
        });
    }
    // VENUE
    // When the email explicitly mentions a venue keyword, treat even a null result as a change
    // (e.g. "venue: PFA seating plan" → value=null, isExplicit=true → clears existing venue).
    // When there is no explicit mention, never overwrite what's already stored.
    const venueMeta = incoming.venueMeta;
    if (venueMeta?.isExplicit) {
        const incomingValue = venueMeta.value ?? null;
        if (existing.venue !== incomingValue) {
            changes.push({
                field: "venue",
                oldValue: existing.venue ?? "null",
                newValue: incomingValue ?? "null",
            });
        }
    }
    else if (incoming.venue != null && existing.venue !== incoming.venue) {
        changes.push({
            field: "venue",
            oldValue: existing.venue ?? "null",
            newValue: incoming.venue,
        });
    }
    return { changes, isRescheduled };
};
// GET EVENTS
export const getEventsService = async ({ status }) => {
    const where = {};
    if (status)
        where.status = status;
    return prisma.event.findMany({
        where,
        orderBy: { confidence: "asc" }, // low confidence first
    });
};
// GET SINGLE EVENT
export const getEventByIdService = async (id) => {
    return prisma.event.findUnique({
        where: { id },
    });
};
// MANUAL UPDATE (REVIEW FIX)
export const updateEventManuallyService = async (id, data) => {
    return prisma.event.update({
        where: { id },
        data: {
            ...data,
            confidence: 1.0, // human override
            status: "confirmed", // review → confirmed
            reviewReason: null,
        },
    });
};
//# sourceMappingURL=event.service.js.map
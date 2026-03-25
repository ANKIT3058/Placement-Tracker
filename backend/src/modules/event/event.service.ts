import {
  createEvent,
  findByEventKey,
  updateEvent,
  formatDateIndia,
  findSimilarEvent,
} from "./event.repository";
import type { CreateEventInput } from "./event.types";
import { prisma } from "../../lib/prisma";
import { formatDateISTKey } from "../../shared/utils/date";

export const upsertEventService = async (data: CreateEventInput) => {
  const dateObj = new Date(data.date);

  const existing = await findSimilarEvent(data.company, data.stage, dateObj);

  if (existing) {
    const changes = detectChanges(existing, data);

    if (changes.length === 0) {
      return existing; // nothing changed
    }

    // store updates
    for (const change of changes) {
      await prisma.eventUpdate.create({
        data: {
          eventId: existing.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
        },
      });
    }

    // update event
    return prisma.event.update({
      where: { id: existing.id },
      data: {
        date: dateObj,
        time: data.time ?? null,
        venue: data.venue ?? null,
      },
    });
  }

  // create new
  const formattedDate = formatDateISTKey(dateObj);
  const eventKey = `${data.company}|${data.stage}|${formattedDate}`;

  return createEvent(data, eventKey);
};

const detectChanges = (existing: any, incoming: any) => {
  const changes = [];

  // DATE
  if (existing.date.toISOString() !== new Date(incoming.date).toISOString()) {
    changes.push({
      field: "date",
      oldValue: existing.date.toISOString(),
      newValue: new Date(incoming.date).toISOString(),
    });
  }

  // TIME
  if (existing.time !== incoming.time) {
    changes.push({
      field: "time",
      oldValue: existing.time || "null",
      newValue: incoming.time || "null",
    });
  }

  // VENUE
  if (existing.venue !== incoming.venue) {
    changes.push({
      field: "venue",
      oldValue: existing.venue || "null",
      newValue: incoming.venue || "null",
    });
  }

  return changes;
};

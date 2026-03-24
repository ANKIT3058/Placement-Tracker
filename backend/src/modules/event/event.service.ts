import {
  createEvent,
  findByEventKey,
  updateEvent,
  formatDateIndia
} from "./event.repository";
import type { CreateEventInput } from "./event.types";

export const createEventService = async (data: CreateEventInput) => {
  const formattedDate = formatDateIndia(new Date(data.date));

  const eventKey = `${data.company}|${data.stage}|${formattedDate}`;
  // later: validation, matching, etc.
  return createEvent(data, eventKey);
};

export const upsertEventService = async (data: CreateEventInput) => {
  const formattedDate = formatDateIndia(new Date(data.date));

  const eventKey = `${data.company}|${data.stage}|${formattedDate}`;

  const existing = await findByEventKey(eventKey);

  if (existing) {
    return updateEvent(existing.id, {
      company: data.company,
      stage: data.stage,
      date: new Date(data.date),
    });
  } else {
    return createEvent(data, eventKey); // ✅ pass same key
  }
};

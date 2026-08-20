import type { Request, Response } from "express";
import { createEventService } from "./event.service.js";
import { requireTenantContext } from "../auth/tenant-context.js";
import {
  getEventsService,
  getEventByIdService,
  updateEventManuallyService,
} from "./event.service.js";
import {
  MANUAL_EVENT_UPDATE_FIELDS,
  type ManualEventUpdate,
} from "./event.types.js";

// Parse a manual-update request body into the narrow contract, or say why it is
// not one.
//
// Unrecognised properties are REFUSED, not stripped. Stripping would apply the
// caller's allowed fields while silently discarding the part of the request that
// was rejected — so a client attempting to reassign ownership would receive a
// 200 and no correction, and a reviewer whose field name was a typo would be
// told their edit succeeded. A request is honoured whole or not at all.
//
// This runs before the ownership lookup, so a malformed request never reaches a
// query, and before Prisma, so a contract violation is a 400 rather than a
// PrismaClientValidationError surfacing as a 500.
type ParsedManualUpdate =
  | { ok: true; value: ManualEventUpdate }
  | { ok: false; message: string };

const parseManualEventUpdate = (body: unknown): ParsedManualUpdate => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be an object" };
  }

  const received = body as Record<string, unknown>;
  const allowed: readonly string[] = MANUAL_EVENT_UPDATE_FIELDS;

  const unsupported = Object.keys(received).filter(
    (key) => !allowed.includes(key),
  );

  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `Unsupported field(s): ${unsupported.join(", ")}. Only ${allowed.join(
        ", ",
      )} can be edited.`,
    };
  }

  const value: ManualEventUpdate = {};

  for (const field of MANUAL_EVENT_UPDATE_FIELDS) {
    if (!(field in received)) {
      continue;
    }

    const supplied = received[field];

    if (typeof supplied !== "string") {
      return { ok: false, message: `${field} must be a string` };
    }

    value[field] = supplied;
  }

  // An edit that names no field is not a correction. Accepting it would let an
  // empty PATCH confirm an Event no human actually reviewed.
  if (Object.keys(value).length === 0) {
    return {
      ok: false,
      message: `At least one of ${allowed.join(", ")} is required`,
    };
  }

  return { ok: true, value };
};

export const createEventController = async (req: Request, res: Response) => {
  try {
    // Ownership comes from the session, never from the request body. A `userId`
    // in the payload is not read and is not trusted (RFC-001 §15.3).
    const context = requireTenantContext(req);

    const event = await createEventService(context, req.body);
    res.status(201).json(event);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

// GET /event?status=review
export const getEventsController = async (req: Request, res: Response) => {
  try {
    const context = requireTenantContext(req);
    const { status } = req.query;

    const events = await getEventsService(context, {
      status: status as string,
    });

    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch events" });
  }
};

// GET /event/:id
//
// 404 covers both "no such Event" and "not yours" (RFC-001 §9.4). They are
// answered identically on purpose: a distinct 403 would confirm the existence of
// a record the caller may not see, and Event ids are sequential and therefore
// trivially enumerable.
export const getEventByIdController = async (req: Request, res: Response) => {
  try {
    const context = requireTenantContext(req);
    const { id } = req.params;

    const event = await getEventByIdService(context, Number(id));

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json(event);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch event" });
  }
};

// PATCH /event/:id
export const updateEventController = async (req: Request, res: Response) => {
  try {
    const context = requireTenantContext(req);
    const { id } = req.params;

    const parsed = parseManualEventUpdate(req.body);

    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }

    const updated = await updateEventManuallyService(
      context,
      Number(id),
      parsed.value,
    );

    if (!updated) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event" });
  }
};

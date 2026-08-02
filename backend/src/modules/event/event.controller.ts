import type { Request, Response } from "express";
import { createEventService } from "./event.service.js";
import { requireTenantContext } from "../auth/tenant-context.js";
import {
  getEventsService,
  getEventByIdService,
  updateEventManuallyService,
} from "./event.service.js";

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

    const updated = await updateEventManuallyService(
      context,
      Number(id),
      req.body,
    );

    if (!updated) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event" });
  }
};

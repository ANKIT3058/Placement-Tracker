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
    const { status } = req.query;

    const events = await getEventsService({
      status: status as string,
    });

    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch events" });
  }
};

// GET /event/:id
export const getEventByIdController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const event = await getEventByIdService(Number(id));

    res.json(event);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch event" });
  }
};

// PATCH /event/:id
export const updateEventController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const updated = await updateEventManuallyService(Number(id), req.body);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event" });
  }
};

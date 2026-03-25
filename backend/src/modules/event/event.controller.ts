import type { Request, Response } from "express";
import { upsertEventService } from "./event.service";

export const createEventController = async (req: Request, res: Response) => {
  try {
    const event = await upsertEventService(req.body);
    res.status(201).json(event);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};
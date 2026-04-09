import type { Request, Response } from "express";
import { processEmail } from "./email.service";

export const receiveEmailController = async (req: Request, res: Response) => {
  try {
    const result = await processEmail(req.body);
    res.status(201).json({ ...result, venue: result?.venue ?? null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Email processing failed" });
  }
};
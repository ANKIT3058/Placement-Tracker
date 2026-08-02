import type { Request, Response } from "express";
import { createEmail } from "./email.repository.js";
import { enqueueEmailProcessing } from "./email.producer.js";

export const receiveEmailController = async (req: Request, res: Response) => {
  try {
    const { subject, body, sender } = req.body;

    if (!subject || !body || !sender) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const savedEmail = await createEmail({
      subject,
      body,
      sender,
    });

    // This route is still unauthenticated (AC-5.12 removes or gates it), so
    // there is no owner to attribute the Email to. It is ingested unowned, and
    // recognition therefore runs in the null tenant — matching only other
    // unowned records, exactly as it did before ownership existed.
    await enqueueEmailProcessing({
      emailId: savedEmail.id,
      userId: savedEmail.userId,
    });

    return res.status(202).json({
      success: true,
      message: "Email queued for processing",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to process email",
    });
  }
};

import type { Request, Response } from "express";
import { createEmail } from "./email.repository.js";
import { enqueueEmailProcessing } from "./email.producer.js";
import { requireTenantContext } from "../auth/tenant-context.js";

// Manual ingestion.
//
// AC-5.9 made this route authenticated, and not as a security improvement in its
// own right — it is a precondition of the migration. `Email.userId` is now NOT
// NULL, so an Email cannot be written without an owner, and an unauthenticated
// caller has none to give. The route could either acquire an owner or stop
// existing; acquiring one is the smaller change, and RFC-001 §15.2 already
// required auth on it.
//
// Whether it survives at all is still open: §15.2 says "removed, or gated behind
// auth and restricted to non-production", and the non-production restriction is
// AC-5.13's to decide.
export const receiveEmailController = async (req: Request, res: Response) => {
  try {
    const context = requireTenantContext(req);

    const { subject, body, sender } = req.body;

    if (!subject || !body || !sender) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const savedEmail = await createEmail({
      userId: context.userId,
      subject,
      body,
      sender,
    });

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

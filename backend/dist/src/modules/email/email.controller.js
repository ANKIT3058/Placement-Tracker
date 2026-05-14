import { processEmail } from "./email.service.js";
export const receiveEmailController = async (req, res) => {
    try {
        const result = await processEmail(req.body);
        res.status(201).json({ ...result, venue: result?.venue ?? null });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ message: "Email processing failed" });
    }
};
//# sourceMappingURL=email.controller.js.map
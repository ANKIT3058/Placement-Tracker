import { processEmail } from "./email.service.js";
import { getEmailById, updateEmailStatus, markEmailFailed } from "./email.repository.js";
import { EMAIL_STATUS } from "../../shared/constants/email.constants.js";
export const processEmailJob = async (emailId) => {
    const email = await getEmailById(emailId);
    if (!email) {
        throw new Error("Email not found");
    }
    await updateEmailStatus(emailId, EMAIL_STATUS.PROCESSING);
    try {
        await processEmail(email, emailId);
        await updateEmailStatus(emailId, EMAIL_STATUS.COMPLETED);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await markEmailFailed(emailId, message);
        throw error;
    }
};
//# sourceMappingURL=email.processor.js.map
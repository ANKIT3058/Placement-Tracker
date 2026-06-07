import { emailQueue } from "../../infrastructure/queue/queues.js";
import { JOB_NAMES } from "../../shared/constants/queue.constants.js";
export const enqueueEmailProcessing = async (emailId) => {
    await emailQueue.add(JOB_NAMES.PROCESS_EMAIL, {
        emailId,
    }, {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
    });
};
//# sourceMappingURL=email.producer.js.map
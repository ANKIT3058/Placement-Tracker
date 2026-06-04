import { Queue } from "bullmq";
import { redis } from "../redis/redis.js";
import { QUEUE_NAMES } from "../../shared/constants/queue.constants.js";

export const emailQueue = new Queue(QUEUE_NAMES.EMAIL_PROCESSING, {
  connection: redis,
});

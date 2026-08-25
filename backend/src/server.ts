import app from "./app.js";
import { startGmailScheduler } from "./modules/gmail/gmail.scheduler.js";
import { startEmailReconciliationScheduler } from "./modules/email/email.scheduler.js";
import { startAttachmentReconciliationScheduler } from "./modules/attachment/attachment.scheduler.js";
import { connectSessionRedis } from "./infrastructure/redis/session-redis.js";

const PORT = process.env.PORT || 3000;

// The session store's client must be connected before it can serve a request:
// node-redis throws rather than queueing when closed. Connecting here rather
// than at module import keeps importing `app` free of side effects, which the
// test suite depends on.
//
// Awaited before `listen` so the server never accepts a request it cannot
// authenticate. A failure here is fatal and loud — a process that starts
// without a session store answers every sign-in with an opaque 500.
await connectSessionRedis();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  startGmailScheduler();

  // Independent of the Gmail scheduler above — its own timer, its own guard.
  // Recovering an email that was persisted but never queued must keep working
  // when Gmail sync is stalled, since the outage that strands an email is
  // exactly the kind of moment that also stalls sync (F-3e, F-2b).
  startEmailReconciliationScheduler();

  // Its own timer and its own guard again, for the same reason: attachment work
  // is stranded by different failures than email work, and G-7.1's replay
  // window leaves rows that NOTHING else can re-enqueue (G-7.3). The sweep only
  // produces jobs — the attachment worker has no production runtime until
  // G-7.4, so recovered work waits in a durable queue until one exists.
  startAttachmentReconciliationScheduler();
});
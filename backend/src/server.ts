import app from "./app.js";
import { startGmailScheduler } from "./modules/gmail/gmail.scheduler.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  startGmailScheduler();
});
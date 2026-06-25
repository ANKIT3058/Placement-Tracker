export const CONFIDENCE_THRESHOLD = 0.6;

// How often the background Gmail scheduler triggers a sync of all accounts.
export const GMAIL_SYNC_INTERVAL_MS =
  Number(process.env.GMAIL_SYNC_INTERVAL_MS) || 120000;
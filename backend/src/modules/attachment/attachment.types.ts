// Metadata extracted from a Gmail message part during sync. This is the ONLY
// attachment information captured while syncing — the file bytes are downloaded
// later by the attachment worker.
export interface AttachmentMetadata {
  gmailAttachmentId: string;
  filename: string;
  mimeType: string;
  size: number | null;
}

// Payload carried by an attachment-processing BullMQ job.
export type AttachmentJobData = {
  attachmentId: number;
};

// Lifecycle of a single attachment's processing (download today, plus
// PDF/Excel parsing and extraction in later sprints).
export const ATTACHMENT_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type AttachmentStatus =
  (typeof ATTACHMENT_STATUS)[keyof typeof ATTACHMENT_STATUS];

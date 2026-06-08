export interface EmailInput {
  gmailMessageId?: string | null;
  subject: string;
  body: string;
  sender: string;
}

export type EmailJobData = {
  emailId: number;
};

export interface CreateEventInput {
  company: string;
  stage: string;
  date: string; // will convert to Date later
  time?: string | null;
  venue?: string | null;
}
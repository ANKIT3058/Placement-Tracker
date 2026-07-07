import { parseMessage } from "../gmail.service";

// Minimal Gmail message shapes mirroring the `users.messages.get` response.
const buildMessage = (payload: unknown) => ({
  id: "msg-1",
  snippet: "snippet",
  payload,
});

describe("parseMessage attachment metadata", () => {
  test("extracts metadata for real attachments and skips inline body parts", () => {
    const message = buildMessage({
      headers: [
        { name: "Subject", value: "Placement drive" },
        { name: "From", value: "tpo@college.edu" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("hello").toString("base64url") },
        },
        {
          mimeType: "application/pdf",
          filename: "schedule.pdf",
          body: { attachmentId: "att-123", size: 2048 },
        },
      ],
    });

    const parsed = parseMessage(message);

    expect(parsed.attachments).toEqual([
      {
        gmailAttachmentId: "att-123",
        filename: "schedule.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]);
  });

  test("finds attachments nested in multipart subtrees", () => {
    const message = buildMessage({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "application/octet-stream",
              filename: "seating.xlsx",
              body: { attachmentId: "att-xyz" },
            },
          ],
        },
      ],
    });

    const parsed = parseMessage(message);

    expect(parsed.attachments).toEqual([
      {
        gmailAttachmentId: "att-xyz",
        filename: "seating.xlsx",
        mimeType: "application/octet-stream",
        size: null,
      },
    ]);
  });

  test("returns an empty array when there are no attachments", () => {
    const message = buildMessage({
      headers: [{ name: "Subject", value: "No files" }],
      mimeType: "text/plain",
      body: { data: Buffer.from("body").toString("base64url") },
    });

    expect(parseMessage(message).attachments).toEqual([]);
  });
});

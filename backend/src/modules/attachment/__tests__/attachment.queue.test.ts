// The attachment queue contract.
//
// This suite exists to PIN the payload shape, not to change it. A queue is not
// an authenticated channel — anything that can reach Redis can enqueue a job —
// so a `userId` travelling in a payload would be a claim, never a fact
// (RFC-001 §9.5). The attachment pipeline avoids the question entirely: the
// payload carries an id, and the worker derives the owner from the persisted
// Attachment that id resolves to (see document-processing.service.test.ts).
//
// Adding `userId` here would introduce a second, weaker answer to "who owns
// this work" alongside the authoritative one already in the database. These
// assertions fail if anyone does.

jest.mock("../../../infrastructure/redis/redis", () => ({ redis: {} }));

jest.mock("bullmq", () => {
  const mockAdd = jest.fn();
  return {
    Queue: jest.fn(() => ({ add: mockAdd })),
    __mockAdd: mockAdd,
  };
});

import * as bullmq from "bullmq";
import { enqueueAttachmentProcessing } from "../attachment.queue";
import { JOB_NAMES } from "../../../shared/constants/queue.constants";

const add = (bullmq as unknown as { __mockAdd: jest.Mock }).__mockAdd;

const ATTACHMENT_ID = 7;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("attachment job payload", () => {
  test("carries the attachment id and nothing else", async () => {
    await enqueueAttachmentProcessing(ATTACHMENT_ID);

    const payload = add.mock.calls[0]![1];

    expect(payload).toEqual({ attachmentId: ATTACHMENT_ID });
    expect(Object.keys(payload)).toEqual(["attachmentId"]);
  });

  test("does not carry a userId claim", async () => {
    await enqueueAttachmentProcessing(ATTACHMENT_ID);

    expect(add.mock.calls[0]![1]).not.toHaveProperty("userId");
  });

  test("enqueues under the process-attachment job name", async () => {
    await enqueueAttachmentProcessing(ATTACHMENT_ID);

    expect(add).toHaveBeenCalledWith(
      JOB_NAMES.PROCESS_ATTACHMENT,
      { attachmentId: ATTACHMENT_ID },
      expect.objectContaining({ jobId: `attachment-${ATTACHMENT_ID}` }),
    );
  });

  test("keeps the deterministic jobId that makes the enqueue idempotent", async () => {
    await enqueueAttachmentProcessing(ATTACHMENT_ID);

    expect(add.mock.calls[0]![2]).toMatchObject({
      jobId: `attachment-${ATTACHMENT_ID}`,
      attempts: 3,
    });
  });
});

import type { ParsedAttachment } from "./parsed-attachment.types.js";

// The contract every document parser implements. The registry selects a parser
// by asking each one whether it `supports` a MIME type, then delegates parsing
// to `parse`. Adding a new format means adding a new implementation of this
// interface — the worker and DocumentProcessingService never change.
export interface AttachmentParser {
  // True if this parser can handle the given MIME type. The registry relies on
  // this alone to route documents, so MIME-type knowledge lives here — never in
  // the worker or processing service.
  supports(mimeType: string): boolean;

  // Parse a previously-downloaded file (referenced by its storage path) into the
  // normalized ParsedAttachment shape.
  parse(filePath: string): Promise<ParsedAttachment>;
}

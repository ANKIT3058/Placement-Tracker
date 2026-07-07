import type { AttachmentParser } from "./attachment-parser.interface.js";
import type { ParsedAttachment } from "./parsed-attachment.types.js";

// Placeholder PDF parser. `supports` is complete so the registry can already
// route PDFs here; `parse` is intentionally unimplemented — actual text
// extraction lands in a later sprint. See the framework PR notes.
export class PdfParser implements AttachmentParser {
  supports(mimeType: string): boolean {
    return mimeType === "application/pdf";
  }

  async parse(_filePath: string): Promise<ParsedAttachment> {
    throw new Error("Not implemented");
  }
}

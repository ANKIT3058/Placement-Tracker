import type { AttachmentParser } from "./attachment-parser.interface.js";
import type { ParsedAttachment } from "./parsed-attachment.types.js";

// The MIME types Gmail reports for legacy .xls and modern .xlsx spreadsheets.
const EXCEL_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// Placeholder Excel parser. `supports` is complete so the registry can already
// route spreadsheets here; `parse` is intentionally unimplemented — actual cell
// extraction lands in a later sprint.
export class ExcelParser implements AttachmentParser {
  supports(mimeType: string): boolean {
    return EXCEL_MIME_TYPES.has(mimeType);
  }

  async parse(_filePath: string): Promise<ParsedAttachment> {
    throw new Error("Not implemented");
  }
}

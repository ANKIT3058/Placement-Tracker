import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import type { AttachmentParser } from "./attachment-parser.interface.js";
import type { ParsedAttachment } from "./parsed-attachment.types.js";
import type { PdfMetadata } from "./types/parser-metadata.interface.js";
import { TextNormalizer } from "../utils/text-normalizer.js";

// Extracts a plain-text layer from PDF attachments using pdf-parse (pdf.js under
// the hood). Text extraction only — no AI, no entity recognition, no
// persistence; those live in later sprints / other modules.
export class PdfParser implements AttachmentParser {
  supports(mimeType: string): boolean {
    return mimeType === "application/pdf";
  }

  async parse(filePath: string): Promise<ParsedAttachment> {
    const data = await readFile(filePath);
    const parser = new PDFParse({ data });

    try {
      // pageJoiner overrides pdf-parse's default decorative separator
      // ("-- 1 of 2 --") with a plain paragraph break, so `text` holds the
      // document's actual content and pages remain separated as paragraphs.
      const textResult = await parser.getText({ pageJoiner: "\n\n" });
      const info = await parser.getInfo();

      const text = TextNormalizer.normalize(textResult.text);

      // Both fields are best-effort — pdf-parse only reports what pdf.js can
      // read from the document, so omit them when unavailable rather than
      // inventing values.
      const metadata: PdfMetadata = {};

      if (typeof textResult.total === "number") {
        metadata.pages = textResult.total;
      }

      const pdfVersion = info.info?.PDFFormatVersion;
      if (pdfVersion !== undefined) {
        metadata.pdfVersion = pdfVersion;
      }

      return { text, metadata };
    } finally {
      // Always release pdf.js worker/document resources, even on parse failure.
      await parser.destroy();
    }
  }
}

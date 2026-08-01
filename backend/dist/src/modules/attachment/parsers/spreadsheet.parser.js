import ExcelJS from "exceljs";
import { TextNormalizer } from "../utils/text-normalizer.js";
// The MIME type Gmail reports for modern .xlsx spreadsheets. Legacy .xls and
// .csv are intentionally out of scope for now (they need different readers), so
// this parser advertises support for .xlsx alone.
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// Separators used when flattening the grid into plain text.
const CELL_SEPARATOR = " | ";
const ROW_SEPARATOR = "\n\n";
const SHEET_SEPARATOR = "\n\n";
// Extracts spreadsheet content from .xlsx attachments using exceljs. The parser
// preserves the workbook exactly — worksheet names, row order and cell order —
// and does NOT interpret it: no header detection, no schema inference, no cell
// merging, no name detection, no AI. Formatting and formulas are ignored; only
// each cell's *displayed* value is read.
//
// Two views are produced from the same read: a flattened `text` layer for the
// AI stage, and `structuredData` (SpreadsheetData) that keeps the original grid
// shape for anything that needs row/column positions. Persistence and failure
// handling live elsewhere (repository / DocumentProcessingService); this class
// only parses.
export class SpreadsheetParser {
    supports(mimeType) {
        return mimeType === XLSX_MIME_TYPE;
    }
    async parse(filePath) {
        const workbook = new ExcelJS.Workbook();
        // Any read/parse error propagates — we deliberately do not swallow it, so
        // DocumentProcessingService can record it as a parsingError.
        await workbook.xlsx.readFile(filePath);
        const sheets = workbook.worksheets.map((worksheet) => this.extractSheet(worksheet));
        const structuredData = { sheets };
        const text = TextNormalizer.normalize(this.buildText(sheets));
        return { text, structuredData };
    }
    // Read a worksheet into a plain SpreadsheetSheet, preserving its name and
    // iterating the used range in order. Empty rows/cells inside the range are
    // kept (as empty strings) so positions are not silently shifted — the grid is
    // preserved, not compacted.
    extractSheet(worksheet) {
        const columnCount = worksheet.columnCount;
        const rowCount = worksheet.rowCount;
        const rows = [];
        for (let rowNumber = 1; rowNumber <= rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const cells = [];
            for (let colNumber = 1; colNumber <= columnCount; colNumber++) {
                // `.text` is exceljs's displayed value: formulas resolve to their shown
                // result, dates/numbers use their display string, and formatting is
                // dropped. Empty cells yield "".
                cells.push(row.getCell(colNumber).text);
            }
            rows.push({ cells });
        }
        return { name: worksheet.name, rows };
    }
    // Flatten the structured sheets into the AI-facing plain text. Each sheet is
    // introduced by a "Sheet: <name>" header, then one line per row with cells
    // joined by " | ". Rows and sheets are separated by blank lines. Content is
    // preserved verbatim (only the shared TextNormalizer runs afterwards) — no
    // aggressive cleaning.
    buildText(sheets) {
        return sheets
            .map((sheet) => {
            const header = `Sheet: ${sheet.name}`;
            const body = sheet.rows
                .map((row) => row.cells.join(CELL_SEPARATOR))
                .join(ROW_SEPARATOR);
            return body.length > 0 ? `${header}${ROW_SEPARATOR}${body}` : header;
        })
            .join(SHEET_SEPARATOR);
    }
}
//# sourceMappingURL=spreadsheet.parser.js.map
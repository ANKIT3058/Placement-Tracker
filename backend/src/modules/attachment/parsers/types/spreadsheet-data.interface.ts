// Structured representation of a parsed spreadsheet. This is the faithful,
// lossless-in-order counterpart to the flattened `text` field: it preserves the
// workbook's sheets, rows and cells exactly as read, with NO interpretation
// (no header detection, schema inference, cell merging or name detection).
// Downstream AI consumes `text`; anything that needs the original grid shape
// (row/column positions) uses this instead.

// A single row: its cells in left-to-right order. Displayed cell values only —
// formulas are resolved to their shown result and formatting is dropped.
export interface SpreadsheetRow {
  cells: string[];
}

// A single worksheet, keeping its tab name and its rows in top-to-bottom order.
export interface SpreadsheetSheet {
  name: string;
  rows: SpreadsheetRow[];
}

// The whole workbook: its worksheets in workbook order.
export interface SpreadsheetData {
  sheets: SpreadsheetSheet[];
}

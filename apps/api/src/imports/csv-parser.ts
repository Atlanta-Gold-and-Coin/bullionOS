/**
 * Minimal RFC-4180-ish CSV parser. Handles:
 *   - Comma delimiters
 *   - Double-quoted fields with embedded commas, newlines, and "" escapes
 *   - CRLF and LF row terminators
 *   - Trailing newline (ignored)
 *
 * Returns a list of header-keyed records. Headers are lowercased and
 * trimmed so column casing doesn't matter to operators. Empty rows
 * are skipped.
 *
 * NOT a streaming parser — loads the whole file into memory. Fine for
 * the import use case (caps enforced upstream); not appropriate for
 * gigabyte-scale CSVs.
 */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseRows(input);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 1 && row[0].trim() === '') continue;
    const rec: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      rec[headers[j]] = (row[j] ?? '').trim();
    }
    out.push(rec);
  }
  return out;
}

function parseRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      // Treat \r\n as one row terminator.
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  // Flush last cell + row if anything remains.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

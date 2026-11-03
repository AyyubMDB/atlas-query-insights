/**
 * Minimal dependency-free CSV serializer. Handles flat arrays of plain
 * objects; nested objects/arrays (e.g. the exact query document) are
 * JSON-stringified into a single cell rather than becoming "[object Object]".
 *
 * @param {object[]} rows
 * @param {string[]} [excludeKeys] columns to omit entirely (e.g. large/raw
 *   fields you only want in the JSON output, not the spreadsheet)
 */
export function toCsv(rows, excludeKeys = []) {
  if (!rows.length) return "";
  const exclude = new Set(excludeKeys);
  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((k) => {
        if (!exclude.has(k)) set.add(k);
      });
      return set;
    }, new Set())
  );

  const escape = (value) => {
    if (value === undefined || value === null) return "";
    const str =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

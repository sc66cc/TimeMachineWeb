// Only the first slice of a CSV is read in the browser. Column mapping needs the header and a
// handful of rows; the full file goes straight to OSS and is parsed server-side.

const PREVIEW_BYTES = 128 * 1024;
const PREVIEW_ROW_LIMIT = 8;

export interface CsvPreview {
  delimiter: string;
  headerList: readonly string[];
  rowList: readonly (readonly string[])[];
  truncated: boolean;
}

const CANDIDATE_DELIMITERS = [",", "\t", ";", "|"] as const;

function detectDelimiter(headerLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = splitCsvLine(headerLine, candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 splitting: quotes protect the delimiter, and "" is a literal quote. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const fieldList: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      fieldList.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fieldList.push(field);
  return fieldList;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export async function readCsvPreview(file: File): Promise<CsvPreview> {
  const slice = file.slice(0, Math.min(PREVIEW_BYTES, file.size));
  const text = new TextDecoder("utf-8").decode(await slice.arrayBuffer());
  const lineList = splitLines(text);
  // A trailing partial line from the byte cut would parse as bogus data.
  const complete =
    slice.size < file.size && lineList.length > 1
      ? lineList.slice(0, -1)
      : lineList;
  const nonEmpty = complete.filter((line) => line.trim().length > 0);
  const headerLine = nonEmpty[0];
  if (headerLine === undefined) {
    throw new Error("The file has no readable rows.");
  }
  const delimiter = detectDelimiter(headerLine);
  const headerList = splitCsvLine(headerLine, delimiter).map((value) =>
    value.trim(),
  );
  if (headerList.length < 2) {
    throw new Error("The first row must be a header with at least two columns.");
  }
  const rowList = nonEmpty
    .slice(1, 1 + PREVIEW_ROW_LIMIT)
    .map((line) => splitCsvLine(line, delimiter).map((value) => value.trim()));
  return {
    delimiter,
    headerList,
    rowList,
    truncated: slice.size < file.size,
  };
}

const LONGITUDE_HINTS = ["lng", "long", "longitude", "lon", "x", "decimallong"];
const LATITUDE_HINTS = ["lat", "latitude", "y", "decimallat"];
const AGE_START_HINTS = ["maxma", "max_ma", "agestart", "maxage", "oldage", "earlyage", "from"];
const AGE_END_HINTS = ["minma", "min_ma", "ageend", "minage", "youngage", "lateage", "to"];
const OCCURRENCE_HINTS = ["count", "occurrence", "occurrences", "abundance", "weight", "n"];
const PLATE_ID_HINTS = ["plateid", "plate_id", "plate"];

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_\-.]/g, "");
}

function guessColumn(
  headerList: readonly string[],
  hintList: readonly string[],
): string {
  const normalizedList = headerList.map(normalizeHeader);
  for (const hint of hintList) {
    const normalizedHint = normalizeHeader(hint);
    const exact = normalizedList.indexOf(normalizedHint);
    if (exact >= 0) {
      return headerList[exact] ?? "";
    }
  }
  for (const hint of hintList) {
    const normalizedHint = normalizeHeader(hint);
    const partial = normalizedList.findIndex((header) =>
      header.includes(normalizedHint),
    );
    if (partial >= 0) {
      return headerList[partial] ?? "";
    }
  }
  return "";
}

export interface ColumnMappingGuess {
  ageEndColumn: string;
  ageStartColumn: string;
  latitudeColumn: string;
  longitudeColumn: string;
  occurrenceColumn: string;
  plateIdColumn: string;
}

export function guessColumnMapping(
  headerList: readonly string[],
): ColumnMappingGuess {
  return {
    ageEndColumn: guessColumn(headerList, AGE_END_HINTS),
    ageStartColumn: guessColumn(headerList, AGE_START_HINTS),
    latitudeColumn: guessColumn(headerList, LATITUDE_HINTS),
    longitudeColumn: guessColumn(headerList, LONGITUDE_HINTS),
    occurrenceColumn: guessColumn(headerList, OCCURRENCE_HINTS),
    plateIdColumn: guessColumn(headerList, PLATE_ID_HINTS),
  };
}

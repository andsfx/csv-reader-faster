// csv-reader 1.0.0, re-read for speed: fields are slices of the input text, not character-by-character
// concatenation. run({text, header}) returns exactly readCsv's {columns, rows, errors} for every input.

const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;

// One lookup per character: comma, line break, quote end an unquoted run; quote, CR, LF end a quoted run.
const STOP_UNQUOTED = new Uint8Array(65536);
STOP_UNQUOTED[COMMA] = 1;
STOP_UNQUOTED[LF] = 1;
STOP_UNQUOTED[CR] = 1;
STOP_UNQUOTED[QUOTE] = 1;
const STOP_QUOTED = new Uint8Array(65536);
STOP_QUOTED[QUOTE] = 1;
STOP_QUOTED[LF] = 1;
STOP_QUOTED[CR] = 1;

// The parse cursor lives outside the helpers so the hot loop allocates no state object per field.
let T = '';
let N = 0;
let pos = 0;
let line = 1;
let recLine = 1;
let recRow = null;
let errs = [];
let ended = 0; // 0 end of text, 1 comma, 2 line break
let kept = 0; // characters the last unquoted run kept, excluding stray CRs

export function run(input) {
  T = String(input.text);
  N = T.length;
  const header = input.header === true;
  pos = N > 0 && T.charCodeAt(0) === 0xFEFF ? 1 : 0;
  line = 1;
  recLine = 1;
  recRow = null;
  errs = [];

  let columns = null;
  let width = -1;
  const rows = [];

  for (;;) {
    // A run of line breaks with no characters on them makes no record.
    while (pos < N) {
      const c = T.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && T.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= N) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let wasQuoted = false;
    for (;;) {
      wasQuoted = T.charCodeAt(pos) === QUOTE;
      fields.push(wasQuoted ? readQuoted() : readUnquoted(''));
      if (ended !== 1) break;
    }

    // A line of only stray CRs leaves one empty unquoted field: no record, but its errors stay.
    if (fields.length === 1 && fields[0] === '' && !wasQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errs.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errs.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  const answer = { columns: header ? (columns ?? []) : null, rows, errors: errs };
  T = '';
  errs = [];
  return answer;
}

// An unquoted run from pos, prefixed by `prefix`. A stray CR is dropped (stray_cr); a quote is literal.
function readUnquoted(prefix) {
  let seg = pos;
  let out = prefix;
  let added = 0;
  for (;;) {
    let i = seg;
    while (i < N && STOP_UNQUOTED[T.charCodeAt(i)] === 0) i += 1;
    if (i >= N) {
      pos = N;
      ended = 0;
      kept = added + (N - seg);
      return out === '' ? T.slice(seg, N) : out + T.slice(seg, N);
    }
    const c = T.charCodeAt(i);
    if (c === COMMA) {
      pos = i + 1;
      ended = 1;
      kept = added + (i - seg);
      return out === '' ? T.slice(seg, i) : out + T.slice(seg, i);
    }
    if (c === LF) {
      pos = i + 1;
      line += 1;
      ended = 2;
      kept = added + (i - seg);
      return out === '' ? T.slice(seg, i) : out + T.slice(seg, i);
    }
    if (c === CR) {
      if (T.charCodeAt(i + 1) === LF) {
        pos = i + 2;
        line += 1;
        ended = 2;
        kept = added + (i - seg);
        return out === '' ? T.slice(seg, i) : out + T.slice(seg, i);
      }
      errs.push({ code: 'stray_cr', line: recLine, row: recRow });
      out += T.slice(seg, i);
      added += i - seg;
      seg = i + 1;
      continue;
    }
    out += T.slice(seg, i + 1); // a quote inside an unquoted field stays a literal quote
    added += i - seg + 1;
    seg = i + 1;
  }
}

// A quoted field opened at pos. Doubled quotes collapse, CR/CRLF become LF, junk after closing is kept.
function readQuoted() {
  const open = pos;
  const openLine = line;
  let seg = open + 1;
  let out = '';
  let built = false;
  let i = seg;
  for (;;) {
    while (i < N && STOP_QUOTED[T.charCodeAt(i)] === 0) i += 1;
    if (i >= N) {
      // No closing quote: the opening quote is literal and the text after it is read again unquoted.
      pos = open + 1;
      line = openLine;
      errs.push({ code: 'unterminated_quote', line: recLine, row: recRow });
      return '"' + readUnquoted('');
    }
    const c = T.charCodeAt(i);
    if (c === LF) {
      // The LF stays inside the slice; only the line counter moves.
      line += 1;
      i += 1;
      continue;
    }
    if (c === CR) {
      out = built ? out + T.slice(seg, i) : T.slice(seg, i);
      out += '\n';
      built = true;
      line += 1;
      seg = i + (T.charCodeAt(i + 1) === LF ? 2 : 1);
      i = seg;
      continue;
    }
    if (T.charCodeAt(i + 1) === QUOTE) {
      out = built ? out + T.slice(seg, i) : T.slice(seg, i);
      out += '"';
      built = true;
      seg = i + 2;
      i = seg;
      continue;
    }
    // The closing quote.
    const value = built ? (i === seg ? out : out + T.slice(seg, i)) : T.slice(seg, i);
    pos = i + 1;
    if (pos >= N) {
      ended = 0;
      return value;
    }
    const after = T.charCodeAt(pos);
    if (after === COMMA) {
      pos += 1;
      ended = 1;
      return value;
    }
    if (after === LF) {
      pos += 1;
      line += 1;
      ended = 2;
      return value;
    }
    if (after === CR && T.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      ended = 2;
      return value;
    }
    const junk = readUnquoted('');
    if (kept > 0) errs.push({ code: 'quote_junk', line: recLine, row: recRow });
    return value + junk;
  }
}

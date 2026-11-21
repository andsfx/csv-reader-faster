// A faster drop-in for csv-reader 1.0.0.
//
// run({text, header}) returns the same {columns, rows, errors} csv-reader 1.0.0 returns, read by the
// same broken-row policy. The difference is that this reader never builds a field a character at a
// time: a field is a pair of offsets into the text, handed to String.prototype.slice once, and only a
// field that genuinely changes (a doubled quote, a CR inside quotes, text after a closing quote) is
// assembled from its parts.
//
// The scan is a 65536-byte lookup table with a 1 at the characters that end a run of plain text
// (comma, LF, CR, and a quote standing where an unquoted field would have it); one array load per
// character, and every slice is a view on the original string rather than a copy.

const CR = 13;
const LF = 10;
const COMMA = 44;
const QUOTE = 34;

/** How a field ended: at a comma, at a line break, at the end of the text. */
const ENDED_END = 0;
const ENDED_COMMA = 1;
const ENDED_BREAK = 2;

/** 1 at the characters that end a run of unquoted text: comma, LF, CR, quote (a literal one there). */
const STOP_UNQUOTED = new Uint8Array(65536);
STOP_UNQUOTED[COMMA] = 1;
STOP_UNQUOTED[LF] = 1;
STOP_UNQUOTED[CR] = 1;
STOP_UNQUOTED[QUOTE] = 1;

/** 1 at the characters that end a run of quoted text: quote, LF, CR. */
const STOP_QUOTED = new Uint8Array(65536);
STOP_QUOTED[QUOTE] = 1;
STOP_QUOTED[LF] = 1;
STOP_QUOTED[CR] = 1;

// The read state, in module scope: one pass, no reentrancy, so the hot functions take no state
// argument and allocate no state object per field.
let sText = '';
let sLen = 0;
let sPos = 0;
let sLine = 1;
let sRecordLine = 1;
let sRecordRow = null;
let sEnded = ENDED_END; // how the field just read ended
let sAdded = 0; // how many characters the last unquoted run kept, not counting dropped CRs

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const fast = readFast(text, header);
  if (fast !== null) return fast;
  return readSlow(text, header);
}

/** The policy's read, in field spans and slices. Returns null for text it cannot read by slicing. */
function readFast(text, header) {
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  sText = text;
  sLen = n;
  sPos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  sLine = 1;
  sRecordLine = 1;
  sRecordRow = null;

  for (;;) {
    // A line with no characters is no record.
    for (;;) {
      if (sPos >= n) break;
      const c = text.charCodeAt(sPos);
      if (c === LF) {
        sPos += 1;
        sLine += 1;
      } else if (c === CR && text.charCodeAt(sPos + 1) === LF) {
        sPos += 2;
        sLine += 1;
      } else {
        break;
      }
    }
    if (sPos >= n) break;

    sRecordLine = sLine;
    sRecordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let quoted = false;
    for (;;) {
      quoted = text.charCodeAt(sPos) === QUOTE;
      fields.push(quoted ? readQuoted(errors) : readUnquoted('', errors));
      if (sEnded !== ENDED_COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: sRecordLine, row: sRecordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: sRecordLine, row: sRecordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  sText = '';
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/**
 * Reads unquoted text from sPos onto `prefix` up to the next comma or line break: a CR not followed
 * by LF is dropped (stray_cr), a quote is one more literal character.
 */
function readUnquoted(prefix, errors) {
  const text = sText;
  const n = sLen;
  let seg = sPos;
  let out = prefix;
  let added = 0;
  for (;;) {
    let i = seg;
    while (i < n && STOP_UNQUOTED[text.charCodeAt(i)] === 0) i += 1;
    if (i >= n) {
      sPos = n;
      sEnded = ENDED_END;
      sAdded = added + (n - seg);
      return out === '' ? text.slice(seg, n) : out + text.slice(seg, n);
    }
    const c = text.charCodeAt(i);
    if (c === COMMA) {
      sPos = i + 1;
      sEnded = ENDED_COMMA;
      sAdded = added + (i - seg);
      return out === '' ? text.slice(seg, i) : out + text.slice(seg, i);
    }
    if (c === LF) {
      sPos = i + 1;
      sLine += 1;
      sEnded = ENDED_BREAK;
      sAdded = added + (i - seg);
      return out === '' ? text.slice(seg, i) : out + text.slice(seg, i);
    }
    if (c === CR) {
      if (text.charCodeAt(i + 1) === LF) {
        sPos = i + 2;
        sLine += 1;
        sEnded = ENDED_BREAK;
        sAdded = added + (i - seg);
        return out === '' ? text.slice(seg, i) : out + text.slice(seg, i);
      }
      // A stray CR is dropped and the characters on its two sides join.
      errors.push({ code: 'stray_cr', line: sRecordLine, row: sRecordRow });
      if (i !== seg) {
        out = out + text.slice(seg, i);
        added += i - seg;
      }
      seg = i + 1;
      continue;
    }
    // A quote inside an unquoted field is a literal character.
    out = out + text.slice(seg, i + 1);
    added += i - seg + 1;
    seg = i + 1;
  }
}

/**
 * Reads a quoted field whose opening quote is at sPos. "" inside it is one quote, each CRLF or lone
 * CR inside it is one LF, and what follows its closing quote up to the next comma or line break is
 * appended as it stands (quote_junk, when the field ends with characters added). A quote that never
 * closes is a literal character: the reader goes back to just after it, says so, and reads the rest
 * as an unquoted field.
 */
function readQuoted(errors) {
  const text = sText;
  const n = sLen;
  const open = sPos;
  const openLine = sLine;
  let seg = open + 1;
  let out = '';
  let built = false; // out holds the value once something had to be transformed
  let i = seg;

  for (;;) {
    while (i < n && STOP_QUOTED[text.charCodeAt(i)] === 0) i += 1;
    if (i >= n) {
      // The quote never closes: it is a literal character and the text after it reads as unquoted.
      sPos = open + 1;
      sLine = openLine;
      errors.push({ code: 'unterminated_quote', line: sRecordLine, row: sRecordRow });
      return readUnquoted('"', errors);
    }
    const c = text.charCodeAt(i);
    if (c === LF) {
      // A line break inside quotes stays in the value as it stands and moves the line on.
      sLine += 1;
      i += 1;
      continue;
    }
    if (c === CR) {
      // CRLF and a lone CR inside quotes are each one LF.
      if (!built) {
        out = text.slice(seg, i);
        built = true;
      } else if (i !== seg) {
        out = out + text.slice(seg, i);
      }
      out += '\n';
      sLine += 1;
      seg = i + (text.charCodeAt(i + 1) === LF ? 2 : 1);
      i = seg;
      continue;
    }
    if (text.charCodeAt(i + 1) === QUOTE) {
      // A doubled quote is one quote.
      if (!built) {
        out = text.slice(seg, i);
        built = true;
      } else if (i !== seg) {
        out = out + text.slice(seg, i);
      }
      out += '"';
      seg = i + 2;
      i = seg;
      continue;
    }
    // The closing quote.
    const value = built ? (i === seg ? out : out + text.slice(seg, i)) : text.slice(seg, i);
    sPos = i + 1;
    if (sPos >= n) {
      sEnded = ENDED_END;
      return value;
    }
    const after = text.charCodeAt(sPos);
    if (after === COMMA) {
      sPos += 1;
      sEnded = ENDED_COMMA;
      return value;
    }
    if (after === LF) {
      sPos += 1;
      sLine += 1;
      sEnded = ENDED_BREAK;
      return value;
    }
    if (after === CR && text.charCodeAt(sPos + 1) === LF) {
      sPos += 2;
      sLine += 1;
      sEnded = ENDED_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted('', errors);
    if (sAdded > 0) errors.push({ code: 'quote_junk', line: sRecordLine, row: sRecordRow });
    return value + junk;
  }
}

/**
 * csv-reader 1.0.0's own read, a character at a time. readFast covers every shape the policy itself
 * produces; this keeps the answer exact for anything it does not, and it is never on the fast path.
 */
function readSlow(text, header) {
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  const error = (code) => errors.push({ code, line: recordLine, row: recordRow });

  function readUnq(value) {
    let added = 0;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        pos += 1;
        sEnded = ENDED_COMMA;
        return { value, added };
      }
      if (c === LF) {
        pos += 1;
        line += 1;
        sEnded = ENDED_BREAK;
        return { value, added };
      }
      if (c === CR) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
          pos += 2;
          line += 1;
          sEnded = ENDED_BREAK;
          return { value, added };
        }
        error('stray_cr');
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    sEnded = ENDED_END;
    return { value, added };
  }

  function readQ() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === QUOTE) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === QUOTE) {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === CR) {
        value += '\n';
        line += 1;
        pos += pos + 1 < n && text.charCodeAt(pos + 1) === LF ? 2 : 1;
        continue;
      }
      if (c === LF) line += 1;
      value += c;
      pos += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnq('"');
    }
    if (pos >= n) {
      sEnded = ENDED_END;
      return { value };
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      sEnded = ENDED_COMMA;
      return { value };
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      sEnded = ENDED_BREAK;
      return { value };
    }
    if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      sEnded = ENDED_BREAK;
      return { value };
    }
    const junk = readUnq(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      field = quoted ? readQ() : readUnq('');
      fields.push(field.value);
    } while (sEnded === ENDED_COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

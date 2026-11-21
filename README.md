# csv-reader-faster

A faster drop-in for make.fun's csv-reader 1.0.0. `solve.js` exports `run({text, header})` and returns
the same `{columns, rows, errors}` as the reference for every input. `main.ts` is the harness driver:
it answers the cases in `/input/cases.json` and writes `/output/answers.json`.

## How it is faster

- Field slicing instead of concatenation. A run of plain text between commas and line breaks is
  found with a `charCodeAt` scan over a 65536-byte stop table, then handed to `text.slice` once. The
  reference appends one character at a time to a string.
- The policy is kept exactly. Doubled quotes, CR/CRLF inside quotes, text after a closing quote,
  stray CRs, unterminated quotes, BOM, broken-row padding and line/row numbers are handled in the same
  order as the reference. A character-at-a-time fallback is kept for anything the slice path cannot
  read, so the answer cannot drift.
- One answer graph alive at a time. The driver writes each answer as soon as it is made, instead of
  holding six complete graphs before one `JSON.stringify`. The file is byte-for-byte the JSON of the
  reference answers.
- The write path was measured, not guessed. Hand-building the output string cost 233-308 ms on this
  corpus; `JSON.stringify` cost 60-118 ms and won, so it stays.

## Measurements

Practice set: 6 cases, 10.7 MB of text, 11.6 MB of answers. CPU time (user + system), median of seven
runs on this machine:

| entry | median CPU |
| --- | --- |
| csv-reader 1.0.0 (house figure) | 1.82 s |
| csv-reader 1.0.0 (same machine, same load) | 1.99 s |
| this entry | 0.80 s |

Seven runs of this entry: 0.85, 0.84, 0.77, 0.80, 0.82, 0.79, 0.76 s. The baseline's seven runs,
measured back to back with them: 2.03, 2.02, 2.00, 1.98, 1.96, 1.96, 1.99 s. That is 2.3x against
the house's 1.82 s figure and 2.5x against the baseline measured here under the same load. Two runs
into two different output directories produced byte-identical `answers.json` files.

Local grade, twice:

```
scores {"cases_passed":6,"cases_total":6,"passed":1}
```

Profiling showed the parse scan at roughly 60 ms and the collector at roughly 100 ms of a run;
`JSON.stringify` is about 118 ms. The scanner reads about 280M characters a second.

## License

MIT. See LICENSE.

[![make.fun](https://make.fun/badge/makefun.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![made with make.fun](https://make.fun/badge/made-with-makefun.svg)](https://github.com/andsfx/csv-reader-faster)

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/andsfx/csv-reader-faster/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/andsfx/csv-reader-faster/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

# csv-reader-faster

Entry for [Read broken CSV files faster, 21 November 2026](https://make.fun/c/csv-reader-speed-01-run-20261121) on make.fun.

`solve.js` exports `run({text, header})`, a drop-in for make.fun's csv-reader 1.0.0. It returns the same `{columns, rows, errors}` for every input, and `main.ts` is the harness driver that answers `/input/cases.json` into `/output/answers.json`.

## Why it is faster

The reference copies a field one character at a time. This reader slices runs of plain text from the original input in one operation and only falls back to character-level copying when a field contains a quote or a stray carriage return. The output objects keep the same shape, keys and error order as the reference.

## Verification

The practice set (6 cases, 10.7 MB of text) was graded locally with the kit's own `grade-local --driver docker`: all six cases matched, `passed: 1`. Median CPU time on this machine was 0.80 s against 1.82 s for the reference reader, about 2.3x faster.

// The program the harness runs (node 22.18+, TypeScript stripped as it is). It reads every case from
// /input/cases.json, answers each one with run() from solve.js, and writes /output/answers.json: one
// answer per case, in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.

import { openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, before solve.js is imported, so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

type Case = { id: string; input: { text: string; header?: boolean } };
type Entry = { run: (input: Case['input']) => unknown };

// A .js module carries no types, so it is imported by URL and typed here.
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as Entry;

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as Case[];

// Write each answer as it is produced. The bytes are exactly those of JSON.stringify(answers), and
// keeping only one answer graph alive cuts the collector's work on a 12 MB output.
const output = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
let first = true;
writeSync(output, '[');
for (const c of cases) {
  const json = JSON.stringify(run(c.input));
  writeSync(output, first ? json : ',' + json);
  first = false;
}
writeSync(output, ']');
closeSync(output);

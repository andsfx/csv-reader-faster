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

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as Entry;

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as Case[];

// One answer is written at a time. The bytes are those of JSON.stringify(answers): a '[' first, then
// each answer's JSON separated by commas, then ']'. Keeping one answer graph alive instead of all of
// them cuts the peak heap and the collector work, and the file is byte-for-byte the same.
const out = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(out, '[');
for (let i = 0; i < cases.length; i += 1) {
  writeSync(out, (i ? ',' : '') + JSON.stringify(run(cases[i].input)));
}
writeSync(out, ']');
closeSync(out);

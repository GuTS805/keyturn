// Turns the soak log (one JSON line per run) into the markdown page docs/evidence/soak-handoff.md.
//   node cli/scripts/soak-report.mjs <soak.jsonl> > docs/evidence/soak-handoff.md
import { readFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const retried = rows.filter((r) => r.retried > 0);
const finals = {};
for (const r of rows) finals[r.final] = (finals[r.final] || 0) + 1;
console.log('# Hand-off soak\n');
console.log(`Runs: ${rows.length}, from ${rows[0]?.started} to ${rows[rows.length - 1]?.started}.`);
console.log('Each run is one safe round trip: the contract hands a release with a deliberately wrong approved hash to OutLayer, the worker refuses it, nothing is published. A run passes when the contract ends the hand-off with the worker\'s final `hash_mismatch` and holds no money afterwards.\n');
console.log(`Passed: ${rows.filter((r) => r.passed).length} of ${rows.length}.`);
console.log(`Runs in which the contract had to ask again by itself (a lost answer, a failed call, or \`pending\`): ${retried.length}.\n`);
console.log('How the runs ended:\n');
for (const [k, v] of Object.entries(finals)) console.log(`- ${k}: ${v}`);
console.log('\n| run | started (UTC) | asked again | ended | passed |\n|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.version} | ${r.started} | ${r.retried} | ${r.final} | ${r.passed ? 'yes' : 'no'} |`);
if (retried.length) {
  console.log('\n## Runs that needed retries\n');
  for (const r of retried) console.log(`- ${r.version}: ${r.events.map((e) => `+${e.at}s ${e.event}${e.error ? ' ' + e.error : ''}`).join(', ')}`);
}

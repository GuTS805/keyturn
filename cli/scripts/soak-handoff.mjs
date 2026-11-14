// Soak test for the hand-off: every few minutes, one safe round trip through the contract and
// OutLayer (the approved hash is deliberately wrong, so the worker refuses and nothing is
// published). It records how many attempts the contract needed and how each ended, so a lost
// answer that the contract heals shows up in the log.
//
//   node --env-file=.env cli/scripts/soak-handoff.mjs <artifact-url> [--runs 25] [--every-minutes 4] [--out soak.jsonl]
//
// Each run registers one more release on the contract (a few hundred bytes of storage) and costs
// well under 0.01 NEAR; the 0.08 NEAR attached to request_publish comes back unless it is spent.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('https://'));
if (!url) throw new Error('usage: soak-handoff.mjs <https artifact url> [--runs N] [--every-minutes M] [--out file]');
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const runs = Number(opt('--runs', 25));
const every = Number(opt('--every-minutes', 4)) * 60000;
const out = opt('--out', 'soak.jsonl');
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'demo-handoff.mjs');
const stamp = Date.now().toString(36);

function once(version) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file=.env', demo, version, url, '--yes', '--tamper'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', () => resolve(text));
  });
}

for (let i = 1; i <= runs; i++) {
  const version = `0.0.8-soak-${stamp}-${i}`;
  const started = new Date().toISOString();
  const text = await once(version);
  const events = [...text.matchAll(/^\s+\+(\d+)s (\S+)(?: (\S+))?(?: \(([^)]*)\))?/gm)].map((m) => ({ at: Number(m[1]), event: m[2], error: m[3], note: m[4] }));
  const retried = Number(/retried by itself: (\d+)/.exec(text)?.[1] ?? 0);
  const final = [...events].reverse().find((e) => e.event === 'publish_failed' || e.event === 'release_published' || e.event === 'publish_gave_up');
  const line = { version, started, retried, final: final ? `${final.event} ${final.error || ''}`.trim() : 'no answer', passed: /ALL CHECKS PASSED/.test(text), events };
  appendFileSync(out, JSON.stringify(line) + '\n');
  console.log(`${started} run ${i}/${runs}: retried ${retried}, ${line.final}, ${line.passed ? 'PASS' : 'FAIL'}`);
  if (i < runs) await new Promise((r) => setTimeout(r, every));
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { NearChain } from './chain.mjs';
import * as cmd from './commands.mjs';
import { parseTarget } from './util.mjs';
import { attest } from './attest.mjs';

const HELP = `keyturn <command> [options]

Setup (environment):
  KEYTURN_CONTRACT   contract account id
  KEYTURN_NETWORK    testnet (default) or mainnet
  KEYTURN_RPC        override the RPC url
  KEYTURN_ACCOUNT    account that signs
  KEYTURN_KEY        its private key, ed25519:...   (or use the near-cli credentials file)

Commands:
  register  --project npm:name --registry npm --members a,b,c --threshold 2 [--proposers ci] [--window-hours 24]
  propose   <project>@<version> --tarball file.tgz
  approve   <project>@<version>
  status    <project>[@<version>]
  execute   <project>@<version>        start execution once the public window has passed
  flag      <project>@<version> --reason "..." [--bond 0.1]
  dismiss   <project>@<version>        member vote to dismiss a flag
  reject    <project>@<version>        member vote to reject a release
  recall    <project>@<version>        member vote to recall a published release
  verify    <project>@<version> [--registry URL]    exit 1 unless the quorum approved the exact bytes served
            (npm:name@v checks the registry tarball, chrome:<extension id>@v checks the live CRX's ZIP)
  relay     <project>@<version> --artifact-url URL --worker path/to/keyturn-worker   (local mode, direct publish)
            <project>@<version> --stage-id UUID --worker path/to/keyturn-worker      (local mode, staged approve)
            chrome:<extension id>@<version> --artifact-url URL --worker ...          (local mode, Chrome Web Store)
  guardians  --project P --guardians a,b,c --threshold 2   member proposes recovery guardians (the members' threshold must propose the same)
  recovery   start   --project P --members a,b --threshold 2    guardian: ask to replace the members
             approve --project P                                guardian: approve; at the threshold a 7 day public wait starts
             cancel  --project P                                member: veto
             finish  --project P                                anyone: after the wait
             status  --project P
  watch     <project>@<version> --tarball file.tgz [--previous old.tgz | --registry URL] [--flag] [--bond 0.1] [--ai]
            analyse the approved bytes against the previous version; with --flag, flag a risky release in its public window
            --ai adds a second opinion from NEAR AI Cloud (NEAR_AI_API_KEY and KEYTURN_AI_MODEL)
  handoff   <project>@<version> --artifact-url URL [--max-minutes 30]
            hand an Executing release to OutLayer through the contract and keep asking until it is Released or the
            worker gives a final answer (0.08 NEAR is attached per round; what is not spent comes back)
  attest    <tx hash> [--signer ACCOUNT] [--require-tee]
            check a release that was published through OutLayer: the contract itself called it, the pinned build ran,
            the approved hash was in the request, the contract recorded the answer; plus the Intel TDX quote through
            outlayer-verify when it is installed. --signer is the account that signed the request_publish transaction.
  hash      <file>
`;

const options = {
  contract: { type: 'string' },
  network: { type: 'string' },
  rpc: { type: 'string' },
  account: { type: 'string' },
  project: { type: 'string' },
  registry: { type: 'string' },
  members: { type: 'string' },
  proposers: { type: 'string' },
  threshold: { type: 'string' },
  'window-hours': { type: 'string' },
  tarball: { type: 'string' },
  guardians: { type: 'string' },
  previous: { type: 'string' },
  flag: { type: 'boolean' },
  ai: { type: 'boolean' },
  reason: { type: 'string' },
  bond: { type: 'string' },
  'stage-id': { type: 'string' },
  'artifact-url': { type: 'string' },
  worker: { type: 'string' },
  json: { type: 'boolean' },
  signer: { type: 'string' },
  'max-minutes': { type: 'string' },
  'require-tee': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  const { values: v, positionals } = parseArgs({ options, allowPositionals: true });
  const [command, target] = positionals;
  if (!command || v.help || command === 'help') return console.log(HELP);

  if (command === 'hash') {
    if (!target) fail('give a file to hash');
    return console.log(await cmd.hashFile(target));
  }

  const chain = new NearChain({
    network: v.network || process.env.KEYTURN_NETWORK || 'testnet',
    rpcUrl: v.rpc || process.env.KEYTURN_RPC,
    contractId: v.contract || process.env.KEYTURN_CONTRACT,
    accountId: v.account || process.env.KEYTURN_ACCOUNT,
    privateKey: process.env.KEYTURN_KEY,
  });

  if (command === 'attest') {
    if (!target) fail('attest needs the transaction hash of the request_publish call');
    const r = await attest(chain, { txHash: target, signer: v.signer || process.env.KEYTURN_ACCOUNT });
    for (const c of r.checks) console.log(`  ${c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'SKIP'}  ${c.text}`);
    const strict = v['require-tee'] && !r.teeChecked;
    const verdict = r.ok && !strict
      ? `ATTESTED${r.teeChecked ? ' (including the TEE quote)' : ' (the TEE quote was not checked)'}`
      : 'NOT ATTESTED';
    console.log(`\n${verdict}`);
    process.exit(r.ok && !strict ? 0 : 1);
  }

  if (command === 'register') {
    await cmd.register(chain, {
      project: v.project,
      registry: v.registry,
      members: v.members,
      proposers: v.proposers,
      threshold: v.threshold,
      windowHours: v['window-hours'],
    });
    return console.log(`registered ${v.project}`);
  }

  if (command === 'guardians') {
    if (!v.project || !v.guardians || !v.threshold) fail('guardians needs --project, --guardians and --threshold');
    await cmd.proposeGuardians(chain, { project: v.project, guardians: v.guardians, threshold: v.threshold });
    return console.log(`proposed guardians for ${v.project}`);
  }
  if (command === 'recovery') {
    const sub = target;
    if (!v.project) fail('recovery needs --project');
    if (sub === 'start') {
      if (!v.members || !v.threshold) fail('recovery start needs --members and --threshold');
      await cmd.startRecovery(chain, { project: v.project, members: v.members, threshold: v.threshold });
      return console.log('recovery started');
    }
    if (sub === 'approve' || sub === 'cancel' || sub === 'finish') {
      await cmd[sub + 'Recovery'](chain, { project: v.project });
      return console.log(`recovery ${sub}: ok`);
    }
    if (sub === 'status') return console.log(await cmd.recoveryStatus(chain, { project: v.project }));
    fail('recovery needs start, approve, cancel, finish or status');
  }

  if (!target) fail(`${command} needs <project>@<version>`);
  const { project, version } = parseTarget(target);
  const needVersion = () => version || fail(`${command} needs a version: ${project}@<version>`);

  switch (command) {
    case 'propose': {
      needVersion();
      if (!v.tarball) fail('propose needs --tarball');
      const { artifact_hash } = await cmd.propose(chain, { project, version, tarball: v.tarball });
      return console.log(`proposed ${project}@${version}\nhash ${artifact_hash}`);
    }
    case 'approve':
    case 'execute':
    case 'dismiss':
    case 'reject':
    case 'recall':
      needVersion();
      await cmd[command](chain, { project, version });
      return console.log(`${command}: ok for ${project}@${version}`);
    case 'flag':
      needVersion();
      if (!v.reason) fail('flag needs --reason');
      await cmd.flag(chain, { project, version, reason: v.reason, bond: v.bond });
      return console.log(`flagged ${project}@${version}`);
    case 'watch': {
      needVersion();
      if (!v.tarball) fail('watch needs --tarball');
      const ai = v.ai ? { apiKey: process.env.NEAR_AI_API_KEY, model: process.env.KEYTURN_AI_MODEL } : null;
      if (ai && (!ai.apiKey || !ai.model)) fail('--ai needs NEAR_AI_API_KEY and KEYTURN_AI_MODEL');
      const r = await cmd.watch(chain, {
        project, version, tarball: v.tarball, previous: v.previous,
        registryUrl: v.registry || process.env.KEYTURN_NPM_REGISTRY || (v.previous ? undefined : 'https://registry.npmjs.org'),
        flag: v.flag, bond: v.bond, ai,
      });
      console.log(`compared with ${r.comparedWith || 'nothing (no earlier version found)'}`);
      console.log(r.text);
      if (r.note) console.log(r.note);
      if (r.flagged) console.log('FLAGGED: the release is blocked until the members decide');
      process.exit(r.report.verdict === 'flag' ? 3 : 0);
      break;
    }
    case 'status': {
      const s = await cmd.status(chain, { project, version });
      return console.log(v.json ? JSON.stringify(s, null, 2) : cmd.describe(s));
    }
    case 'verify': {
      needVersion();
      const registryUrl = v.registry || (project.startsWith('chrome:')
        ? process.env.KEYTURN_CHROME_UPDATE_URL
        : process.env.KEYTURN_NPM_REGISTRY || 'https://registry.npmjs.org');
      const r = await cmd.verify(chain, { project, version, registryUrl });
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${project}@${version}: ${r.reason}`);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'handoff': {
      needVersion();
      if (!v['artifact-url']) fail('handoff needs --artifact-url');
      const r = await cmd.handoff(chain, { project, version, artifactUrl: v['artifact-url'], maxMinutes: Number(v['max-minutes'] || 30), say: console.log });
      console.log(r.ok ? `RELEASED after ${r.rounds} round(s)` : `NOT RELEASED: ${r.reason}`);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'relay': {
      needVersion();
      if (!v.worker || (!v['stage-id'] && !v['artifact-url'])) fail('relay needs --worker and one of --artifact-url or --stage-id');
      const r = await cmd.relay(chain, {
        project,
        version,
        stageId: v['stage-id'],
        artifactUrl: v['artifact-url'],
        runWorker: cmd.runWorkerBinary(v.worker),
      });
      console.log(JSON.stringify(r.result));
      process.exit(r.confirmed ? 0 : 2);
      break;
    }
    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

main().catch((e) => fail(e.message || String(e)));

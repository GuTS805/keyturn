#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { NearChain } from './chain.mjs';
import * as cmd from './commands.mjs';
import { parseTarget } from './util.mjs';

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
  reason: { type: 'string' },
  bond: { type: 'string' },
  'stage-id': { type: 'string' },
  'artifact-url': { type: 'string' },
  worker: { type: 'string' },
  json: { type: 'boolean' },
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

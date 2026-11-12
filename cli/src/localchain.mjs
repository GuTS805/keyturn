import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.platform === 'win32' ? '.exe' : '';
export const LOCAL_CHAIN_BIN = path.join(root, 'contract/target/debug/examples/localchain' + exe);

/** Build the local chain (the real contract code, run natively) if it is missing. */
export function buildLocalChain() {
  if (existsSync(LOCAL_CHAIN_BIN)) return;
  const r = spawnSync('cargo', ['build', '--example', 'localchain'], { cwd: path.join(root, 'contract'), stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !existsSync(LOCAL_CHAIN_BIN)) throw new Error('could not build the local chain; run: cd contract && cargo build --example localchain');
}

/**
 * A chain with no network. It runs the real contract in a child process, with a
 * virtual clock, so waiting for the public window takes no time.
 * `net.as(account)` gives an object with the same view/call as NearChain.
 */
export class LocalNet {
  constructor({ worker = 'worker.local', startMs = Date.now() } = {}) {
    buildLocalChain();
    this.worker = worker;
    this.nowMs = startMs;
    this.child = spawn(LOCAL_CHAIN_BIN, [worker], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.waiting = [];
    this.closed = false;
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (!line.startsWith('REPLY ')) return; // contract event logs share stdout
      const next = this.waiting.shift();
      if (next) next(JSON.parse(line.slice(6)));
    });
    this.child.on('exit', () => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) w({ ok: false, error: 'the local chain stopped' });
    });
    this.queue = Promise.resolve();
  }

  advance(ms) {
    this.nowMs += ms;
  }

  send(request) {
    // One request at a time keeps replies in order.
    const run = () =>
      new Promise((resolve) => {
        if (this.closed) return resolve({ ok: false, error: 'the local chain stopped' });
        this.waiting.push(resolve);
        this.child.stdin.write(JSON.stringify(request) + '\n');
      });
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  as(accountId) {
    const net = this;
    return {
      accountId,
      contractId: 'keyturn.local',
      async view(method, args = {}) {
        const r = await net.send({ kind: 'view', method, sender: accountId, args, now_ms: net.nowMs });
        if (!r.ok) throw new Error(r.error);
        return r.result;
      },
      async call(method, args = {}, { deposit = 0n } = {}) {
        const r = await net.send({ kind: 'call', method, sender: accountId, args, deposit_yocto: String(deposit), now_ms: net.nowMs });
        if (!r.ok) throw new Error(r.error);
        return r.result;
      },
    };
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

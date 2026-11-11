import { Account, JsonRpcProvider } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const RPC = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

const DEFAULT_GAS = 100_000_000_000_000n; // 100 Tgas

function keyFromCredentialsFile(network, accountId) {
  const file = path.join(homedir(), '.near-credentials', network, `${accountId}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')).private_key;
  } catch {
    return undefined;
  }
}

/**
 * Thin wrapper around the contract. `view` needs no key.
 * `call` needs KEYTURN_ACCOUNT plus a key from KEYTURN_KEY or the
 * near-cli credentials file for that account.
 */
export class NearChain {
  constructor({ network = 'testnet', rpcUrl, contractId, accountId, privateKey }) {
    if (!contractId) throw new Error('set KEYTURN_CONTRACT or pass --contract');
    this.contractId = contractId;
    this.accountId = accountId;
    this.network = network;
    this.provider = new JsonRpcProvider({ url: rpcUrl || RPC[network] });
    const key = privateKey || (accountId ? keyFromCredentialsFile(network, accountId) : undefined);
    this.account = accountId && key ? new Account(accountId, this.provider, key) : undefined;
  }

  async view(method, args = {}) {
    return this.provider.callFunction({ contractId: this.contractId, method, args });
  }

  async call(method, args = {}, { deposit = 0n, gas = DEFAULT_GAS } = {}) {
    if (!this.account) {
      throw new Error('signing needs KEYTURN_ACCOUNT and a key (KEYTURN_KEY or the near-cli credentials file)');
    }
    return this.account.callFunction({
      contractId: this.contractId,
      methodName: method,
      args,
      deposit,
      gas,
    });
  }
}

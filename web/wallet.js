// A thin wrapper around the NEAR wallet connector (@hot-labs/near-connect).
//
// The connector is loaded only when someone presses "Connect wallet", so a visit that only
// reads costs nothing extra and still works if the CDN is down. The page never sees a key:
// the wallet signs and sends. The loader is injectable for tests.

export const CONNECTOR_URL = 'https://esm.sh/@hot-labs/near-connect@0.11.4';
const REMEMBER = 'keyturn.wallet';

const remember = (on) => {
  try {
    if (on) localStorage.setItem(REMEMBER, '1');
    else localStorage.removeItem(REMEMBER);
  } catch {
    /* storage can be blocked */
  }
};
export const wasConnected = () => {
  try {
    return localStorage.getItem(REMEMBER) === '1';
  } catch {
    return false;
  }
};

export function createWallet({ network = 'testnet', load = () => import(CONNECTOR_URL), onChange = () => {} } = {}) {
  let connector = null;
  let wallet = null;
  let account = null;

  const set = (w, id) => {
    wallet = w;
    account = id;
    onChange(account);
  };

  async function ensure() {
    if (connector) return connector;
    const { NearConnector } = await load();
    const c = new NearConnector({ network });
    c.on('wallet:signIn', async (t) => {
      try {
        set(await c.wallet(), t?.accounts?.[0]?.accountId ?? null);
        remember(true);
      } catch {
        set(null, null);
      }
    });
    c.on('wallet:signOut', () => {
      remember(false);
      set(null, null);
    });
    await c.whenManifestLoaded;
    connector = c;
    return c;
  }

  return {
    network,
    account: () => account,
    /** Open the wallet picker. Resolves once a wallet is connected. */
    async connect() {
      const c = await ensure();
      if (!wallet) {
        const w = await c.connect();
        if (!account) {
          const got = await c.getConnectedWallet().catch(() => null);
          set(w || got?.wallet || null, got?.accounts?.[0]?.accountId ?? null);
        }
      }
      return account;
    },
    /** Pick up a wallet the person connected earlier, without opening anything. */
    async restore() {
      const c = await ensure();
      const got = await c.getConnectedWallet().catch(() => null);
      if (got?.wallet) set(got.wallet, got.accounts?.[0]?.accountId ?? null);
      return account;
    },
    async disconnect() {
      if (connector && wallet) await connector.disconnect();
      remember(false);
      if (account || wallet) set(null, null); // the sign-out event usually did this already
    },
    /** Sign and send. `request` is { receiverId, actions } in the connector's format. */
    async send(request) {
      if (!wallet) throw new Error('Connect a wallet first.');
      return wallet.signAndSendTransaction(request);
    },
  };
}

/** The keyturn events a finished transaction logged, from a wallet's outcome. */
export function eventsFromOutcome(outcome) {
  const out = [];
  for (const r of outcome?.receipts_outcome || []) {
    for (const line of r?.outcome?.logs || []) {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(line.slice('EVENT_JSON:'.length));
        if (e.standard === 'keyturn') out.push(e);
      } catch {
        /* not ours */
      }
    }
  }
  return out;
}

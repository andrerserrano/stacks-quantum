import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';
import { TOKEN } from './execution.mjs';

const { Cl, serializePayload, fetchFeeEstimateTransaction, fetchCallReadOnlyFunction, broadcastTransaction } = stacks;
export const API = 'https://api.hiro.so';

// Read/estimate requests have a timeout. Broadcast uncertainty is propagated;
// Executor has already persisted signed bytes and reconciles the same txid.
export function mainnetApi(candidate, { intervalMs = 300, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const c = candidate;
  let nextQueryAt = 0;
  async function query(input, init) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Math.max(Date.now(), nextQueryAt); nextQueryAt = start + intervalMs;
      if (start > Date.now()) await wait(start - Date.now());
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
      if (response.status !== 429 || attempt === 2) return response;
      const header = response.headers.get('retry-after');
      const seconds = header === null ? attempt + 1 : Number(header);
      if (!Number.isFinite(seconds) || seconds > 30) throw new Error('Mainnet API rate limited; wait for the provider cooldown before retrying');
      await response.body?.cancel();
      await wait(Math.max(1000, seconds * 1000));
    }
  }
  async function get(path, absent = false) {
    const response = await query(API + path);
    if (absent && response.status === 404) return null;
    if (!response.ok) throw new Error(`Mainnet API ${response.status}: ${path}`);
    return response.json();
  }
  async function readAt(principal, functionName, functionArgs) {
    const [contractAddress, contractName] = principal.split('.');
    return fetchCallReadOnlyFunction({ contractAddress, contractName, functionName, functionArgs,
      senderAddress: c.accounts.operator.address, network: 'mainnet', client: { baseUrl: API, fetch: query } });
  }
  return {
    info: () => get('/v2/info'),
    source: principal => get(`/v2/contracts/source/${principal.replace('.', '/')}?proof=0`, true),
    transaction: txid => get(`/extended/v1/tx/${txid}`, true),
    block: height => get(`/extended/v1/block/by_height/${height}`, true),
    async events(txid) {
      const data = await get(`/extended/v1/tx/events?tx_id=${txid}&limit=50`);
      if (data.total !== undefined && data.total > data.events.length) throw new Error('Transfer evidence is paginated; stop rather than verify incomplete events');
      return data.events;
    },
    async account(address) {
      const [core, balance, nonces] = await Promise.all([
        get(`/v2/accounts/${address}?proof=0`),
        get(`/extended/v1/address/${address}/balances`),
        get(`/extended/v1/address/${address}/nonces`),
      ]);
      if (!Number.isSafeInteger(core.nonce) || core.nonce < 0) throw new Error('Unsupported account nonce');
      const available = BigInt(balance.stx.balance) - BigInt(balance.stx.locked);
      if (available < 0n || BigInt(core.balance) < available) throw new Error('Account balance views disagree; retry once indexing catches up');
      if (String(nonces.possible_next_nonce) !== String(core.nonce) && !nonces.detected_mempool_nonces.length) throw new Error('Account nonce views disagree');
      return { nonce: String(core.nonce), availableStx: String(available), missingNonces: nonces.detected_missing_nonces, mempoolNonces: nonces.detected_mempool_nonces };
    },
    read: (fn, args) => readAt(c.vault, fn, args),
    async tokenBalance(address) {
      const result = await readAt(TOKEN, 'get-balance-available', [Cl.principal(address)]);
      if (result.type !== 'ok' || result.value.type !== 'uint') throw new Error('Unexpected sBTC balance response');
      return String(result.value.value);
    },
    async estimate(tx) {
      try {
        return await fetchFeeEstimateTransaction({ payload: serializePayload(tx.payload), estimatedLength: tx.serializeBytes().length,
          network: 'mainnet', client: { baseUrl: API, fetch: query } });
      } catch (e) {
        if (e.constructor.name === 'NoEstimateAvailableError') return { reason: 'NoEstimateAvailable' };
        throw e;
      }
    },
    broadcast: tx => broadcastTransaction({ transaction: tx, network: 'mainnet', client: { baseUrl: API,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } }),
  };
}

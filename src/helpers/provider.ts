import { StaticJsonRpcProvider } from '@ethersproject/providers';
import snapshot from '@snapshot-labs/snapshot.js';

const broviderUrl = process.env.BROVIDER_URL || 'https://rpc.snapshot.org';

/**
 * A direct endpoint for one network, bypassing the brovider's URL convention.
 *
 * snapshot.js builds `${broviderUrl}/${network}`, which suits a multiplexer and
 * suits nothing else — a dedicated gateway answers on its own root and returns
 * "access denied" for the appended path. So a per-network override is read verbatim:
 *
 *   RPC_URL_4663=https://robinhood-chain.gateway.tenderly.co
 *
 * The reason this exists at all: rpc.snapshot.org/4663 began timing out on plain
 * eth_blockNumber, which made every weight read on the site hang on "Checking your
 * balance…" forever — failed reads are deliberately not cached, so the page retried
 * without end rather than showing a wrong number. One unreachable endpoint should not
 * be the whole product's single point of failure.
 */
const directUrls: Record<string, string> = Object.fromEntries(
  Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('RPC_URL_') && !!v)
    .map(([k, v]) => [k.slice('RPC_URL_'.length), String(v)])
);

const cache = new Map<string, StaticJsonRpcProvider>();

export function getProvider(network: string | number) {
  const key = String(network);
  const direct = directUrls[key];
  if (!direct) {
    return snapshot.utils.getProvider(network, {
      broviderUrl,
      clientName: 'score-api'
    });
  }
  // Cached like the brovider's own: a new provider per call would drop connection
  // reuse and turn a chunked log scan into hundreds of fresh TLS handshakes.
  let provider = cache.get(key);
  if (!provider) {
    provider = new StaticJsonRpcProvider(
      { url: direct, timeout: 60_000 },
      Number(network)
    );
    cache.set(key, provider);
  }
  return provider;
}

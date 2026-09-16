import { createHash } from 'crypto';
import { EMPTY_ADDRESS } from './constants';
import { getProvider } from './helpers/provider';
import getStrategies from './helpers/strategies';
import snapshot from './strategies';

export const blockNumByNetwork = {};
const blockNumByNetworkTs = {};
const delay = 120;

export function clone(item) {
  return JSON.parse(JSON.stringify(item));
}

export function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

export function sortObjectByParam(obj: Record<string, any>) {
  // sort object by param name
  const sortedObj: Record<string, any> = {};
  Object.keys(obj)
    .sort()
    .forEach(function (key) {
      sortedObj[key] = obj[key];
    });
  return sortedObj;
}

export function formatStrategies(network, strategies: Array<any> = []) {
  strategies = Array.isArray(strategies) ? strategies : [];
  // update strategy network, strategy parameters should be same order to maintain consistent key hashes
  return strategies
    .map(strategy => ({
      ...strategy,
      network: strategy?.network || network
    }))
    .map(sortObjectByParam);
}

export function checkInvalidStrategies(strategies): Array<string> {
  const strategyNames = strategies.map(strategy => strategy.name);
  const snapshotStrategiesNames = Object.keys(getStrategies());
  const invalidStrategies: Array<string> = strategyNames.filter(
    s => s === undefined || !snapshotStrategiesNames.includes(s)
  );

  return [...new Set(invalidStrategies)];
}

export function rpcSuccess(res, result, id, cache = false) {
  res.json({
    jsonrpc: '2.0',
    result,
    id,
    cache
  });
}

export function rpcError(res, code, e, id) {
  res.status(code).json({
    jsonrpc: '2.0',
    error: {
      code,
      message: 'unauthorized',
      data: e.message || e
    },
    id
  });
}

export async function getCurrentBlockNum(snapshotBlock, network) {
  if (blockNumByNetwork[network] && snapshotBlock <= blockNumByNetwork[network])
    return blockNumByNetwork[network];
  const ts = parseInt((Date.now() / 1e3).toFixed());
  if (blockNumByNetwork[network] && blockNumByNetworkTs[network] > ts - delay)
    return blockNumByNetwork[network];

  const provider = getProvider(network);
  const blockNum = await provider.getBlockNumber();

  blockNumByNetwork[network] = blockNum;
  blockNumByNetworkTs[network] = ts;

  return blockNum;
}

export function getIp(req) {
  const ips = (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.connection.remoteAddress ||
    ''
  ).split(',');

  return ips[0].trim();
}
export function isAddressValid(address: string, allowEmpty = false): boolean {
  if (address === EMPTY_ADDRESS) {
    return allowEmpty;
  }

  try {
    snapshot.utils.getFormattedAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * A weight that is still accruing, and therefore must never be cached or called final.
 *
 * Decided by the STRATEGY, not by configuration. It used to be decided by a Railway
 * environment variable listing the bloc spaces, and that was a trapdoor: the whole
 * anti-double-count property depends on every voter being re-scored over one common
 * window when the ballot closes, that re-score happens only when vp_state is
 * 'pending', and that in turn happened only if the space appeared in the string. Add
 * a ninth community and forget the variable and the tally silently becomes the sum of
 * each voter's weight at the second they signed — which one holder can inflate to
 * about nine times their balance by passing the same coins through a chain of wallets
 * and voting from each. Nothing anywhere cross-checked the list against the spaces.
 *
 * `bloc-twab` integrates over a window, so a bloc-twab score is accruing by
 * construction. The fact and the flag are now the same fact.
 *
 * The variable is still honoured, as an escape hatch for a space that needs the
 * behaviour without the strategy. It can no longer be the only thing holding the
 * property up.
 */
const ACCRUING_STRATEGIES = ['bloc-twab'];

const liveWeightSpaces = (process.env.LIVE_WEIGHT_SPACES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

export const isAccruing = (
  strategies?: Array<{ name?: string }>,
  space?: string
): boolean =>
  (strategies ?? []).some(s => ACCRUING_STRATEGIES.includes(String(s?.name))) ||
  (!!space && liveWeightSpaces.includes(space.toLowerCase()));

/** @deprecated Kept for the escape-hatch path; prefer isAccruing(strategies, space). */
export const isLiveWeightSpace = (space?: string): boolean =>
  !!space && liveWeightSpaces.includes(space.toLowerCase());

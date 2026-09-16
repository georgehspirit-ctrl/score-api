import { INVALID_ADDRESS_MESSAGE, MAX_STRATEGIES } from './constants';
import disabled from './disabled.json';
import redis from './redis';
import snapshot from './strategies';
import {
  checkInvalidStrategies,
  getCurrentBlockNum,
  isAddressValid,
  isAccruing,
  sha256
} from './utils';

interface GetVpRequestParams {
  address: string;
  network: string;
  strategies: any[];
  snapshot: number | 'latest';
  space: string;
  delegation?: boolean;
}

interface ValidateRequestParams {
  validation: string;
  author: string;
  space: string;
  network: string;
  snapshot: number | 'latest';
  params: any;
}

const disableCachingForSpaces = [
  'magicappstore.eth',
  'moonbeam-foundation.eth'
];

export function verifyGetVp(params) {
  if (!isAddressValid(params.address)) {
    throw new Error(INVALID_ADDRESS_MESSAGE);
  }

  if (
    !params.strategies ||
    params.strategies.length === 0 ||
    params.strategies.length > MAX_STRATEGIES
  ) {
    throw new Error('invalid strategies length');
  }

  const invalidStrategies = checkInvalidStrategies(params.strategies);
  if (invalidStrategies.length > 0) {
    throw new Error(`invalid strategies: ${invalidStrategies}`);
  }
}

export async function getVp(params: GetVpRequestParams): Promise<{
  result: Awaited<ReturnType<typeof snapshot.utils.getVp>>;
  cache: boolean;
}> {
  if (typeof params.snapshot !== 'number') params.snapshot = 'latest';

  /**
   * A bloc keeps its block, but never its answer.
   *
   * `bloc-twab` integrates a holder's balance from the proposal's own block to the
   * present, so the block must reach the strategy intact — rewriting it to 'latest'
   * would collapse the window to a point and hand back a spot balance. What must not
   * survive is the cache: the number moves every minute the ballot is open, and a
   * 'final' verdict cached on the first read would freeze a holder's weight at what
   * they had when they first looked.
   */
  const accruing = isAccruing(params.strategies, params.space);

  /**
   * The head this reads can be up to two minutes stale, and a ballot is votable the
   * moment it is published. For an ordinary space rewriting a not-yet-reached block
   * to 'latest' is a kindness; for an accruing one it is a hole — the window collapses
   * to a point, the strategy hands back a spot balance, and for the next two minutes
   * anyone can buy one block before signing and take full weight.
   */
  if (params.snapshot !== 'latest' && !accruing) {
    const currentBlockNum = await getCurrentBlockNum(
      params.snapshot,
      params.network
    );
    params.snapshot =
      currentBlockNum < params.snapshot ? 'latest' : params.snapshot;
  }

  const key = sha256(JSON.stringify(params));
  const useCache =
    redis &&
    !accruing &&
    params.snapshot !== 'latest' &&
    !disableCachingForSpaces.includes(params.space);
  if (useCache) {
    const cache = await redis.hGetAll(`vp:${key}`);

    if (cache?.vp_state) {
      cache.vp = parseFloat(cache.vp);

      cache.vp_by_strategy = JSON.parse(cache.vp_by_strategy);
      return { result: cache, cache: true };
    }
  }

  if (['1319'].includes(params.network) || disabled.includes(params.space))
    throw 'something wrong with the strategies';

  const result = await snapshot.utils.getVp(
    params.address,
    params.network,
    params.strategies,
    params.snapshot,
    params.space,
    params.delegation
  );

  /**
   * 'pending' is what makes the closing tally the real one. The sequencer's score
   * job re-scores a proposal at close only when some vote's vp_state is not yet
   * final (snapshot-sequencer/src/scores.ts); call an accruing weight 'final' and
   * the tally freezes at whatever each voter had at the second they signed, which
   * is the one number this mechanism exists to stop counting.
   */
  if (accruing) result.vp_state = 'pending';

  if (useCache && result.vp_state === 'final') {
    const multi = redis.multi();
    multi.hSet(`vp:${key}`, 'vp', result.vp);
    multi.hSet(
      `vp:${key}`,
      'vp_by_strategy',
      JSON.stringify(result.vp_by_strategy)
    );
    multi.hSet(`vp:${key}`, 'vp_state', result.vp_state);
    multi.exec();
  }

  return { result, cache: false };
}

export function verifyValidate(params) {
  if (!isAddressValid(params.author)) {
    throw new Error(INVALID_ADDRESS_MESSAGE);
  }

  if (
    params?.strategies &&
    (params.strategies.length === 0 ||
      params.strategies.length > MAX_STRATEGIES)
  ) {
    throw new Error('invalid strategies length');
  }
}

export async function validate(params: ValidateRequestParams): Promise<{
  result: boolean;
  cache: boolean;
}> {
  if (!params.validation || params.validation === 'any')
    return { result: true, cache: false };

  if (!snapshot.validations[params.validation]) throw 'Validation not found';

  const validation = new snapshot.validations[params.validation].validation(
    params.author,
    params.space,
    params.network,
    params.snapshot,
    params.params
  );

  return { result: await validation.validate(), cache: false };
}

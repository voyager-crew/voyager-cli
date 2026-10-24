import {
  isPolicyExemptOp,
  type AccountPlan,
  type OpCapability,
  type OpName,
  type PolicyReport,
  type PolicyState,
} from '@voyager-crew/bridge-protocol';

import { type BridgeFailure, failure } from '../util/errors';

/**
 * The failure a denied or stale extension policy means for any op. Checked
 * before the op list: the extension then declares no ops, and "unsupported"
 * would hide that the person has to act (412, not 400).
 */
export function policyFailure(
  state: PolicyState | undefined,
  op?: OpName,
): BridgeFailure | undefined {
  // `catalog.refresh` is how a stale policy gets fixed, so the policy cannot refuse it.
  if (op !== undefined && isPolicyExemptOp(op)) return undefined;
  if (state === 'denied') {
    return failure('policy-denied', 'the extension policy does not allow the bridge');
  }
  if (state === 'stale') {
    return failure(
      'policy-stale',
      'the extension policy is out of date; turn on online plugin updates in Voyager',
    );
  }
  return undefined;
}

/** What the server last heard from the paired extension, in memory only. */
export class ExtensionState {
  lastPollAt: number | null = null;
  ops: readonly OpCapability[] | null = null;
  policy: PolicyReport | null = null;
  /** The ChatGPT plan the extension's pages last showed; null until it reports one. */
  account: AccountPlan | null = null;
  /**
   * Jobs the extension runs at once: 1 while its parallel switch is off, more once it is on.
   * Null until it polls, and from a Voyager without parallel jobs (one job at a time).
   */
  maxTasks: number | null = null;

  opNames(): ReadonlySet<OpName> | null {
    return this.ops === null ? null : new Set(this.ops.map((op) => op.name));
  }

  forget(): void {
    this.lastPollAt = null;
    this.ops = null;
    this.policy = null;
    this.account = null;
    this.maxTasks = null;
  }
}

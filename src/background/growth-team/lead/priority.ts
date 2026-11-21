/**
 * The priority of a problem from customer feedback (docs/growth-team.md, Part 8). The model says what happened and
 * to whom; this rule, in code, says how urgent it is, so the same facts always give the same priority.
 *
 * - P0: data loss, security, cannot sign in, payment broken.
 * - P1: a main flow is broken for a paying customer, or for three users or more.
 * - P2: there is a workaround.
 * - P3: nice to have.
 */

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface ProblemFacts {
  dataLoss: boolean;
  security: boolean;
  cannotSignIn: boolean;
  paymentBroken: boolean;
  // A flow the product exists for (sign in, the main task, paying) does not work
  mainFlowBroken: boolean;
  payingCustomer: boolean;
  // How many people reported or are known to be hit; 1 when only the sender
  usersAffected: number;
  hasWorkaround: boolean;
}

export const NO_FACTS: ProblemFacts = {
  dataLoss: false,
  security: false,
  cannotSignIn: false,
  paymentBroken: false,
  mainFlowBroken: false,
  payingCustomer: false,
  usersAffected: 1,
  hasWorkaround: false,
};

/** The priority, and the rule that gave it, in words for the issue. */
export function priorityOf(facts: ProblemFacts): { priority: Priority; because: string } {
  if (facts.dataLoss) return { priority: 'P0', because: 'data loss' };
  if (facts.security) return { priority: 'P0', because: 'a security problem' };
  if (facts.cannotSignIn) return { priority: 'P0', because: 'cannot sign in' };
  if (facts.paymentBroken) return { priority: 'P0', because: 'payment is broken' };
  if (facts.mainFlowBroken && !facts.hasWorkaround && (facts.payingCustomer || facts.usersAffected >= 3)) {
    return {
      priority: 'P1',
      because: facts.payingCustomer
        ? 'a main flow is broken for a paying customer'
        : 'a main flow is broken for three users or more',
    };
  }
  if (facts.mainFlowBroken || facts.hasWorkaround) {
    return {
      priority: 'P2',
      because: facts.hasWorkaround ? 'there is a workaround' : 'a main flow is broken for one user',
    };
  }
  return { priority: 'P3', because: 'nice to have' };
}

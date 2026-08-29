export type A2AStatus = {
  tokenIssued: boolean;
  polling: boolean;
  lastPollAt?: string;
  lastInboxAt?: string;
  lastError?: string;
};

const state: A2AStatus = {
  tokenIssued: false,
  polling: false,
};

export function getA2AStatus(): A2AStatus {
  return { ...state };
}

export function noteA2A(patch: Partial<A2AStatus>) {
  Object.assign(state, patch);
}

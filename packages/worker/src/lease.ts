export interface LeasePolicy { heartbeat_interval_ms: number; lease_ttl_ms: number; lease_safety_factor: number; takeover_grace_ms: number; clock_skew_tolerance_ms: number; takeover_confirmation_count: number; }
export interface RunLease { owner: string | null; owner_pid: number | null; acquired_at: number | null; heartbeat_at: number | null; expires_at: number | null; state_version: number; stale_confirmations: number; policy: LeasePolicy; }
export interface LeaseLivenessProbe { alive: boolean | "unknown"; }

export const DEFAULT_LEASE_POLICY: LeasePolicy = Object.freeze({ heartbeat_interval_ms: 5000, lease_ttl_ms: 30000, lease_safety_factor: 6, takeover_grace_ms: 10000, clock_skew_tolerance_ms: 5000, takeover_confirmation_count: 2 });

export function validateLeasePolicy(policy: LeasePolicy): void {
  if (policy.lease_safety_factor < 4) throw new Error("LEASE_SAFETY_FACTOR_TOO_LOW");
  if (policy.lease_ttl_ms < policy.heartbeat_interval_ms * policy.lease_safety_factor) throw new Error("LEASE_TTL_TOO_SHORT");
  if (policy.takeover_grace_ms < policy.heartbeat_interval_ms * 2) throw new Error("TAKEOVER_GRACE_TOO_SHORT");
  if (policy.takeover_confirmation_count < 2) throw new Error("TAKEOVER_CONFIRMATIONS_TOO_LOW");
}

export function newLease(owner: string, ownerPid: number, policy: LeasePolicy = DEFAULT_LEASE_POLICY, timestamp = Date.now()): RunLease {
  validateLeasePolicy(policy);
  return { owner, owner_pid: ownerPid, acquired_at: timestamp, heartbeat_at: timestamp, expires_at: timestamp + policy.lease_ttl_ms, state_version: 1, stale_confirmations: 0, policy };
}

export function observeLease(lease: RunLease, timestamp: number, probe: LeaseLivenessProbe = { alive: "unknown" }): RunLease {
  const policy = lease.policy;
  validateLeasePolicy(policy);
  const staleAfter = (lease.heartbeat_at || 0) + policy.lease_ttl_ms + policy.takeover_grace_ms + policy.clock_skew_tolerance_ms;
  const expired = timestamp >= staleAfter;
  const confirmations = expired && probe.alive !== true ? lease.stale_confirmations + 1 : 0;
  return { ...lease, stale_confirmations: confirmations, state_version: lease.state_version + 1 };
}

export function isLeaseStale(lease: RunLease, timestamp: number, probe: LeaseLivenessProbe = { alive: "unknown" }): boolean {
  const staleAfter = (lease.heartbeat_at || 0) + lease.policy.lease_ttl_ms + lease.policy.takeover_grace_ms + lease.policy.clock_skew_tolerance_ms;
  return probe.alive !== true && timestamp >= staleAfter && lease.stale_confirmations >= lease.policy.takeover_confirmation_count;
}

export function releaseLease(lease: RunLease): RunLease { return { ...lease, owner: null, owner_pid: null, expires_at: null, state_version: lease.state_version + 1, stale_confirmations: 0 }; }

export function takeoverLease(lease: RunLease, owner: string, ownerPid: number, timestamp: number, probe: LeaseLivenessProbe = { alive: "unknown" }): RunLease | undefined {
  if (!isLeaseStale(lease, timestamp, probe)) return undefined;
  return { ...newLease(owner, ownerPid, lease.policy, timestamp), state_version: lease.state_version + 1 };
}

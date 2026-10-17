/** Claude subscription usage windows (5-hour / 7-day), as last reported by Claude Code. Dependency-free so the budget guard can read it. */

export interface UsageWindow {
  /** Fraction of the window used, 0-1. */
  utilization: number | null;
  resetsAt: string | null;
}

export interface SubscriptionStatus {
  loggedIn: boolean;
  subscriptionType: string | null;
  status: "allowed" | "allowed_warning" | "rejected" | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  updatedAt: number;
}

const g = globalThis as unknown as { __atlasSubscription?: SubscriptionStatus };

/** Last usage-window state seen (updated by every call; shared across HMR reloads). */
export function lastSubscriptionStatus(): SubscriptionStatus | null {
  return g.__atlasSubscription ?? null;
}

export function rememberSubscriptionStatus(patch: Partial<SubscriptionStatus>) {
  g.__atlasSubscription = { loggedIn: true, subscriptionType: null, status: null, fiveHour: null, sevenDay: null, ...g.__atlasSubscription, ...patch, updatedAt: Date.now() };
}

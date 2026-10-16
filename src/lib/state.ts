import type { SessionStatus } from "./types";

/** Terminal states: no further work is scheduled. */
export const TERMINAL_STATUSES: SessionStatus[] = [
  "COMPLETED",
  "DRY_RUN_COMPLETE",
  "STOPPED_BY_USER",
  "STOPPED_BY_BUDGET",
  "FAILED",
];

const STOP: SessionStatus[] = ["PAUSED_ERROR", "STOPPED_BY_USER", "STOPPED_BY_BUDGET", "FAILED"];

/**
 * Allowed transitions. Budget stops during debate jump straight to
 * FINAL_DECISION (controlled stop, the CIO documents pending disagreements
 * using the reserved budget).
 */
export const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  CREATED: ["DISCOVERY", ...STOP],
  DISCOVERY: ["ROUND_1_RUNNING", "DRY_RUN_COMPLETE", ...STOP],
  ROUND_1_RUNNING: ["ROUND_1_COMPLETE", ...STOP],
  ROUND_1_COMPLETE: ["CROSS_REVIEW", ...STOP],
  CROSS_REVIEW: ["DEBATE", "FINAL_DECISION", ...STOP],
  DEBATE: ["VERIFICATION", "FINAL_DECISION", ...STOP],
  VERIFICATION: ["REVISION", "FINAL_DECISION", ...STOP],
  REVISION: ["SELECTIVE_DEBATE", "FINAL_DECISION", ...STOP],
  SELECTIVE_DEBATE: ["FINAL_DECISION", ...STOP],
  FINAL_DECISION: ["COMPLETED", ...STOP],
  COMPLETED: [],
  DRY_RUN_COMPLETE: [],
  // Resuming re-enters the phase that was interrupted.
  PAUSED_ERROR: [
    "CREATED",
    "DISCOVERY",
    "ROUND_1_COMPLETE",
    "ROUND_1_RUNNING",
    "CROSS_REVIEW",
    "DEBATE",
    "VERIFICATION",
    "REVISION",
    "SELECTIVE_DEBATE",
    "FINAL_DECISION",
    "STOPPED_BY_USER",
    "FAILED",
  ],
  STOPPED_BY_USER: [],
  STOPPED_BY_BUDGET: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`Transición de estado no permitida: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Ordered phases, used for resume and progress display. */
export const PHASE_ORDER: SessionStatus[] = [
  "CREATED",
  "DISCOVERY",
  "ROUND_1_RUNNING",
  "ROUND_1_COMPLETE",
  "CROSS_REVIEW",
  "DEBATE",
  "VERIFICATION",
  "REVISION",
  "SELECTIVE_DEBATE",
  "FINAL_DECISION",
  "COMPLETED",
];

export function phaseIndex(s: SessionStatus): number {
  return PHASE_ORDER.indexOf(s);
}

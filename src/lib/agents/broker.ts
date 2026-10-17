import { getSession, listAgentNotes, listCandidates, listReports, type ReportRow } from "../db/repo";
import { isPaused, phaseIndex } from "../state";
import { AGENT_ROLES, type AgentRole } from "../types";

/**
 * Context broker: the ONLY path through which agent prompts receive other
 * agents' work. It enforces the independence of round 1:
 *  - during ROUND_1 an agent gets the candidate list, screening data and its
 *    own private notes — never another agent's report;
 *  - other reports become readable only once all four initial reports exist
 *    and are frozen (session status ≥ ROUND_1_COMPLETE).
 */
export class AccessDeniedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AccessDeniedError";
  }
}

export type BrokerPhase = "ROUND_1" | "POST_ROUND_1";

export function round1Closed(sessionId: string): boolean {
  const s = getSession(sessionId);
  if (!s) return false;
  const initial = listReports(sessionId).filter((r) => r.kind === "INITIAL");
  const allFrozen = AGENT_ROLES.every((role) => initial.some((r) => r.agentRole === role && r.frozen));
  const status = s.resumeStatus && isPaused(s.status) ? s.resumeStatus : s.status;
  return allFrozen && phaseIndex(status) >= phaseIndex("ROUND_1_COMPLETE");
}

export interface Round1Context {
  role: AgentRole;
  candidates: ReturnType<typeof listCandidates>;
  ownNotes: string[];
}

export function round1Context(sessionId: string, role: AgentRole): Round1Context {
  return {
    role,
    candidates: listCandidates(sessionId, true),
    ownNotes: listAgentNotes(sessionId, role),
  };
}

/** Read another agent's reports. Throws while round 1 is open. */
export function readReports(sessionId: string, requester: AgentRole, target: AgentRole): ReportRow[] {
  if (requester !== target && !round1Closed(sessionId)) {
    throw new AccessDeniedError(`${requester} no puede leer el informe de ${target} antes del cierre de la primera ronda`);
  }
  return listReports(sessionId, target);
}

/** All four frozen initial reports + latest versions; available only after round 1. */
export function postRound1Context(sessionId: string, requester: AgentRole) {
  if (!round1Closed(sessionId)) throw new AccessDeniedError("La primera ronda no está cerrada: los informes de los demás agentes siguen ocultos");
  const byRole = Object.fromEntries(
    AGENT_ROLES.map((r) => {
      const reps = readReports(sessionId, requester, r);
      return [r, { initial: reps.find((x) => x.version === 1) ?? null, latest: reps[reps.length - 1] ?? null, all: reps }];
    }),
  ) as Record<AgentRole, { initial: ReportRow | null; latest: ReportRow | null; all: ReportRow[] }>;
  return { reports: byRole, ownNotes: listAgentNotes(sessionId, requester), candidates: listCandidates(sessionId, true) };
}

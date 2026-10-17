"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { PROFILES } from "@/lib/agents/profiles";
import { ROLE_LABELS, VERDICT_LABELS, type AgentRole, type Verdict } from "@/lib/types";

export const fmt = {
  money: (x: unknown, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d }) : "n/d"),
  pct: (x: unknown, d = 1) => (typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/d"),
  num: (x: unknown, d = 1) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "n/d"),
  int: (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x).toLocaleString("es-ES") : "n/d"),
  usd: (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? `${x.toFixed(4)} USD` : "n/d"),
  date: (x: unknown) => (typeof x === "string" && x ? new Date(x).toLocaleString("es-ES") : "n/d"),
  big: (x: unknown) => {
    if (typeof x !== "number" || !Number.isFinite(x)) return "n/d";
    const a = Math.abs(x);
    return a >= 1e9 ? `${(x / 1e9).toFixed(2)} B` : a >= 1e6 ? `${(x / 1e6).toFixed(1)} M` : x.toLocaleString("es-ES", { maximumFractionDigits: 4 });
  },
};

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface-1 ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-2">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="num mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

type Tone = "neutral" | "good" | "warning" | "serious" | "critical" | "accent" | "demo";
const toneCls: Record<Tone, string> = {
  neutral: "border-line text-ink-2 bg-surface-2",
  good: "border-good/50 text-ink bg-good/15",
  warning: "border-warning/60 text-ink bg-warning/20",
  serious: "border-serious/60 text-ink bg-serious/20",
  critical: "border-critical/60 text-ink bg-critical/15",
  accent: "border-accent/50 text-ink bg-accent/15",
  demo: "border-demo/60 text-ink bg-demo/20",
};
const toneIcon: Partial<Record<Tone, string>> = { good: "✓", warning: "!", serious: "▲", critical: "✕", demo: "◆" };

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${toneCls[tone]}`}>
      {toneIcon[tone] && <span aria-hidden>{toneIcon[tone]}</span>}
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  if (["COMPLETED", "DRY_RUN_COMPLETE", "SUCCEEDED", "RESOLVED", "VERIFIED"].includes(status)) return "good";
  if (["FAILED", "CONFLICT", "STOPPED_BY_BUDGET"].includes(status)) return "critical";
  if (["PAUSED_ERROR", "UNRESOLVED", "UNREACHABLE", "CANCELLED", "STOPPED_BY_USER"].includes(status)) return "serious";
  if (["PARTIAL", "PENDING", "OPEN", "UNVERIFIED", "VERIFYING", "PAUSED_LIMIT"].includes(status)) return "warning";
  if (["RUNNING"].includes(status) || status.includes("ROUND") || ["DISCOVERY", "CROSS_REVIEW", "DEBATE", "VERIFICATION", "REVISION", "SELECTIVE_DEBATE", "FINAL_DECISION"].includes(status)) return "accent";
  return "neutral";
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>n/d</Badge>;
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const tone: Tone = verdict === "POTENTIAL_BUY" ? "good" : verdict === "EXCLUDE" ? "critical" : verdict === "PENDING_VERIFICATION" ? "warning" : verdict === "EXCELLENT_TOO_EXPENSIVE" ? "accent" : "neutral";
  return <Badge tone={tone}>{VERDICT_LABELS[verdict]}</Badge>;
}

export function AgentChip({ role, short = false }: { role: AgentRole | "ALL"; short?: boolean }) {
  if (role === "ALL") return <span className="text-xs font-medium text-ink-2">Comité</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PROFILES[role].color }} />
      {short ? role : ROLE_LABELS[role]}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface-1 px-6 py-10 text-center">
      <div className="text-sm font-semibold text-ink">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-xl text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-critical/60 bg-critical/10 px-4 py-3 text-sm text-ink">
      <span aria-hidden className="mr-1 font-bold">✕</span>
      {children}
    </div>
  );
}

export function Notice({ tone = "warning", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-lg border px-4 py-3 text-sm ${toneCls[tone]}`}>{children}</div>;
}

export function Button({ children, onClick, variant = "secondary", disabled, type = "button", title }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "danger"; disabled?: boolean; type?: "button" | "submit"; title?: string }) {
  const v = variant === "primary" ? "bg-accent text-white border-accent hover:opacity-90" : variant === "danger" ? "border-critical/60 text-ink hover:bg-critical/10" : "border-line text-ink hover:bg-surface-2";
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled} className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${v}`}>
      {children}
    </button>
  );
}

export function SessionLink({ href, s, children, className = "" }: { href: string; s: string | null; children: ReactNode; className?: string }) {
  return (
    <Link href={s ? `${href}${href.includes("?") ? "&" : "?"}s=${s}` : href} className={`text-accent hover:underline ${className}`}>
      {children}
    </Link>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`border-b border-line px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3 ${className}`}>{children}</th>;
}
export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-line px-2 py-2 align-top text-sm ${className}`}>{children}</td>;
}

export function VerificationBadge({ v }: { v: string }) {
  const label: Record<string, string> = { VERIFIED: "Verificado", UNVERIFIED: "No verificado", CONFLICT: "Conflicto", UNREACHABLE: "Inaccesible" };
  return <Badge tone={statusTone(v)}>{label[v] ?? v}</Badge>;
}

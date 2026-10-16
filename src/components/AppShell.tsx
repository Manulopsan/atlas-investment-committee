"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { api, useSelectedSession } from "./hooks";
import type { SessionSummary } from "./types";
import { Badge, StatusBadge } from "./ui";

const NAV = [
  { href: "/", label: "Overview", key: "A" },
  { href: "/committee", label: "Committee Room", key: "B" },
  { href: "/debate", label: "Debate", key: "C" },
  { href: "/research", label: "Research", key: "D" },
  { href: "/ranking", label: "Final Ranking", key: "E" },
  { href: "/settings", label: "Settings", key: "G" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("atlas-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);
  const apply = (t: "system" | "light" | "dark") => {
    setTheme(t);
    try {
      if (t === "system") {
        localStorage.removeItem("atlas-theme");
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem("atlas-theme", t);
        document.documentElement.dataset.theme = t;
      }
    } catch {}
  };
  return (
    <div role="group" aria-label="Tema" className="flex overflow-hidden rounded-md border border-line text-xs">
      {(["system", "light", "dark"] as const).map((t) => (
        <button key={t} onClick={() => apply(t)} aria-pressed={theme === t} className={`px-2 py-1 ${theme === t ? "bg-surface-2 font-semibold text-ink" : "text-ink-2"}`}>
          {t === "system" ? "Auto" : t === "light" ? "Claro" : "Oscuro"}
        </button>
      ))}
    </div>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sid, setSid] = useSelectedSession();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ sessions: SessionSummary[] }>("/api/sessions").then((r) => alive && setSessions(r.sessions)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const current = sessions.find((s) => s.id === sid);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-line bg-surface-1 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="px-4 py-3">
          <Link href={sid ? `/?s=${sid}` : "/"} className="block">
            <div className="text-sm font-bold tracking-[0.2em] text-ink">ATLAS</div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3">Investment Committee · AI Equity Research Lab</div>
          </Link>
        </div>
        <nav aria-label="Principal" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={sid && n.href !== "/settings" ? `${n.href}?s=${sid}` : n.href} aria-current={active ? "page" : undefined} className={`flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${active ? "bg-surface-2 font-semibold text-ink" : "text-ink-2 hover:bg-surface-2"}`}>
                <span className="num w-4 text-[10px] text-ink-3">{n.key}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface-0/95 px-4 py-2 backdrop-blur">
          <label className="flex min-w-0 items-center gap-2 text-xs text-ink-2">
            Sesión
            <select value={sid ?? ""} onChange={(e) => setSid(e.target.value || null)} className="max-w-[60vw] rounded-md border border-line bg-surface-1 px-2 py-1 text-xs text-ink md:max-w-xs">
              <option value="">— ninguna —</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id.slice(0, 8)} · {s.mode === "demo" ? "DEMO" : s.mode === "dry_run" ? "EN SECO" : "REAL"} · {s.status} · {new Date(s.createdAt).toLocaleString("es-ES")}
                </option>
              ))}
            </select>
          </label>
          {current && <StatusBadge status={current.status} />}
          {current?.mode === "demo" && <Badge tone="demo">DEMOSTRACIÓN · datos sintéticos</Badge>}
          {current?.running && <Badge tone="accent">en ejecución</Badge>}
          {current?.interrupted && <Badge tone="serious">interrumpida — reanudable</Badge>}
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        {current?.mode === "demo" && (
          <div className="border-b border-demo/50 bg-demo/15 px-4 py-1.5 text-xs text-ink">
            ◆ Sesión de DEMOSTRACIÓN: empresas, datos y opiniones de agentes son SINTÉTICOS (tickers DEMO-*). No son datos reales ni recomendaciones.
          </div>
        )}
        <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-2">Cargando…</div>}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}

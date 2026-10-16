"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const KEY = "atlas-session";

/** Selected session id: ?s= in the URL wins; otherwise the last one used in this browser. */
export function useSelectedSession(): [string | null, (id: string | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = params.get("s");
  const [stored, setStored] = useState<string | null>(null);
  useEffect(() => {
    try {
      setStored(localStorage.getItem(KEY));
    } catch {}
  }, []);
  useEffect(() => {
    if (fromUrl) {
      try {
        localStorage.setItem(KEY, fromUrl);
      } catch {}
    }
  }, [fromUrl]);
  const set = useCallback(
    (id: string | null) => {
      try {
        if (id) localStorage.setItem(KEY, id);
        else localStorage.removeItem(KEY);
      } catch {}
      setStored(id);
      const q = new URLSearchParams(params.toString());
      if (id) q.set("s", id);
      else q.delete("s");
      router.replace(`${pathname}?${q.toString()}`);
    },
    [params, pathname, router],
  );
  return [fromUrl ?? stored, set];
}

/** Polls while the session is active; stops when it reaches a terminal or paused state. */
export function usePolling<T>(url: string | null, active: (d: T) => boolean, intervalMs = 2500) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const d = await api<T>(url);
        if (stop) return;
        setData(d);
        setError(null);
        if (active(d)) timer = setTimeout(load, intervalMs);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, intervalMs]);
  return { data, error, refresh };
}

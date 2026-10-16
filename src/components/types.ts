import type { sessionView, companyView, sessionSummaries } from "@/lib/view";
export type SessionView = NonNullable<ReturnType<typeof sessionView>>;
export type CompanyView = NonNullable<ReturnType<typeof companyView>>;
export type SessionSummary = ReturnType<typeof sessionSummaries>[number];

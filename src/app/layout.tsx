import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "ATLAS Investment Committee",
  description: "AI Equity Research Lab — comité de inversión de cuatro agentes con debate multiagente real",
};

// Applies the stored theme before paint (no flash). Values: "light" | "dark" | absent (system).
const themeScript = `try{var t=localStorage.getItem("atlas-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-surface-0 text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

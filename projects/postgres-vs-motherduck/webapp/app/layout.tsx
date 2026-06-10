import type { ReactNode } from "react";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Inter for body; IBM Plex Mono stands in for MotherDuck's Aeonik Mono on headings.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-brand",
  display: "swap",
});

export const metadata = {
  title: "Postgres vs MotherDuck",
  description: "Same query, same driver — Postgres vs MotherDuck, side by side.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            padding: "14px 24px",
            background: "var(--snow)",
            borderBottom: "2px solid var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          <a href="/" style={{ color: "var(--ink)", fontWeight: 600, textDecoration: "none" }}>
            Postgres vs MotherDuck
          </a>
          <a href="/dashboard" style={{ color: "var(--darker-grey)", textDecoration: "none" }}>
            Dashboard
          </a>
          <span
            aria-hidden
            style={{
              marginLeft: "auto",
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "var(--sun)",
              border: "2px solid var(--ink)",
            }}
          />
        </nav>
        {children}
      </body>
    </html>
  );
}

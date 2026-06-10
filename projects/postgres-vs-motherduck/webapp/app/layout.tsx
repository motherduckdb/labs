import type { ReactNode } from "react";

export const metadata = {
  title: "postgres → motherduck demo",
  description: "Same query, same driver — Postgres vs MotherDuck, side by side.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", color: "#1a1a1a" }}>
        <nav
          style={{
            display: "flex",
            gap: 20,
            padding: "12px 24px",
            borderBottom: "1px solid #eee",
            fontSize: 14,
          }}
        >
          <a href="/" style={{ color: "#1a1a1a", fontWeight: 600, textDecoration: "none" }}>
            Postgres vs MotherDuck
          </a>
          <a href="/dashboard" style={{ color: "#666", textDecoration: "none" }}>
            Dashboard
          </a>
        </nav>
        {children}
      </body>
    </html>
  );
}

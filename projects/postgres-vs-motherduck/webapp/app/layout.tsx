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
      <body>{children}</body>
    </html>
  );
}

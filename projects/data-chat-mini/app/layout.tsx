import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "data-chat-mini",
  description: "Minimal chat-with-your-data on MotherDuck — read-only, mviz charts, local context.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

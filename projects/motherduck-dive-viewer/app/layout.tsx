import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MotherDuck OAuth — Dives',
  description: 'Sign in with MotherDuck, browse your Dives, and view them embedded.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Receipt SaaS',
  description: 'AI-powered receipt-to-expense tracking',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Patron — escrowed patronage on NEAR',
  description:
    'Supporters fund a creator in cycles. Money only leaves the escrow when a supporter quorum ' +
    'confirms a milestone, and anything undelivered refunds itself.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { DEMO_MODE, ESCROW_ID } from '@/lib/config';
import { WalletProvider, useWallet } from '@/lib/wallet';

function Nav() {
  const pathname = usePathname();
  const links: Array<[string, string]> = [
    ['/', 'Campaigns'],
    ['/create', 'Start a campaign'],
    ['/me', 'My support'],
  ];
  const active = (href: string) =>
    href === '/' ? pathname === '/' : Boolean(pathname?.startsWith(href));
  return (
    <nav>
      {links.map(([href, label]) => (
        <Link key={href} href={href} className={active(href) ? 'active' : ''}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

function WalletButton() {
  const { accountId, connect, disconnect, connecting } = useWallet();
  if (DEMO_MODE) {
    return <span className="pill warn">demo mode</span>;
  }
  if (!accountId) {
    return (
      <button onClick={connect} disabled={connecting}>
        {connecting ? 'Opening…' : 'Connect'}
      </button>
    );
  }
  return (
    <div className="row">
      <span className="pill good mono">{accountId}</span>
      <button className="ghost" onClick={disconnect}>
        Sign out
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const deployed = ESCROW_ID && !DEMO_MODE;
  return (
    <WalletProvider>
      <header className="site">
        <Link href="/" className="brand">
          Patron
        </Link>
        <Nav />
        <div className="spacer" />
        <WalletButton />
      </header>
      <main>
        {DEMO_MODE && !dismissed && (
          <div className="notice">
            <strong>Demo mode:</strong> these screens render the contract&apos;s real view shapes
            from sample data, with no wallet and no RPC. Set{' '}
            <span className="mono">NEXT_PUBLIC_ESCROW_ID</span> and{' '}
            <span className="mono">NEXT_PUBLIC_TOKEN_ID</span>, unset{' '}
            <span className="mono">NEXT_PUBLIC_DEMO_MODE</span>, to drive a live deployment.{' '}
            <button className="ghost" onClick={() => setDismissed(true)}>
              hide
            </button>
          </div>
        )}
        {!deployed && !DEMO_MODE && !dismissed && (
          <div className="notice error">
            No contract configured. Set <span className="mono">NEXT_PUBLIC_ESCROW_ID</span> and{' '}
            <span className="mono">NEXT_PUBLIC_TOKEN_ID</span> in <span className="mono">.env.local</span>,
            or run with <span className="mono">NEXT_PUBLIC_DEMO_MODE=true</span> to browse the UI.
          </div>
        )}
        {children}
      </main>
    </WalletProvider>
  );
}

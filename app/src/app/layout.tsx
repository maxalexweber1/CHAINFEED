import type { Metadata } from 'next';
import Link from 'next/link';
import { LogoMark } from '@/components/logo';
import './globals.css';

export const metadata: Metadata = {
  title: 'CHAINFEED · Cardano Stablecoin Health',
  description:
    'Live transparency portal for every Cardano-native stablecoin: peg deviation, reserve attestation, risk score, executable depth, lending-market state. Free public reads, agent-ready API gated by x402 USDM micropayments.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};

const NAV_ITEMS: Array<{ href: string; label: string; accent?: boolean }> = [
  { href: '/',           label: 'Stables' },
  { href: '/compare',    label: 'Compare' },
  { href: '/developers', label: 'API' },
  { href: '/agents',     label: 'For agents' },
  { href: '/trust',      label: 'Trust' },
  { href: '/demo',       label: 'Live demo', accent: true },
];

function NavLinks({ mobile = false }: { mobile?: boolean }) {
  return (
    <>
      {NAV_ITEMS.map(item => (
        <Link
          key={item.href}
          href={item.href}
          className={
            mobile
              ? `text-sm px-3 py-2 rounded hover:bg-(--muted) transition-colors ${
                  item.accent ? 'text-(--accent)' : 'text-(--foreground)'
                }`
              : item.accent
                ? 'text-(--accent) hover:opacity-80 transition-opacity'
                : 'text-(--muted-foreground) hover:text-(--foreground) transition-colors'
          }
        >
          {item.label}
        </Link>
      ))}
    </>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className="min-h-screen flex flex-col"
        suppressHydrationWarning
      >
        <header className="border-b border-(--border) sticky top-0 bg-(--background)/85 backdrop-blur-md z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
            <Link href="/" className="flex items-center gap-2.5 hover:opacity-90 transition-opacity min-w-0">
              <span className="text-(--accent) shrink-0">
                <LogoMark size={22} />
              </span>
              <span className="font-bold tracking-tight text-xl shrink-0">CHAINFEED</span>
              <span className="text-(--muted-foreground) text-sm hidden lg:inline border-l border-(--border) pl-2.5 ml-0.5 truncate">
                Cardano stablecoin transparency
              </span>
            </Link>

            {/* Desktop / tablet inline nav */}
            <nav className="hidden md:flex items-center gap-5 text-sm">
              <NavLinks />
            </nav>

            {/* Mobile hamburger — CSS-only via <details>. Tap toggles a dropdown. */}
            <details className="md:hidden relative">
              <summary
                className="cursor-pointer list-none w-9 h-9 flex items-center justify-center rounded border border-(--border) hover:bg-(--muted) transition-colors"
                aria-label="Open menu"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <line x1="2" y1="5"  x2="16" y2="5"  stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                  <line x1="2" y1="9"  x2="16" y2="9"  stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                  <line x1="2" y1="13" x2="16" y2="13" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                </svg>
              </summary>
              <nav className="absolute right-0 top-full mt-2 min-w-44 bg-(--background) border border-(--border) rounded-lg p-2 flex flex-col gap-0.5 shadow-xl z-50">
                <NavLinks mobile />
              </nav>
            </details>
          </div>
        </header>

        <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
          {children}
        </main>

        <footer className="border-t border-(--border) mt-12">
          <div className="max-w-7xl mx-auto px-6 py-6 text-sm text-(--muted-foreground) flex flex-wrap gap-x-6 gap-y-2 items-center justify-between">
            <span>
              Built on{' '}
              <a href="https://cardano.org" className="hover:text-(--foreground)" target="_blank" rel="noreferrer">Cardano</a>
              {' · '}
              <a href="https://github.com/ODATANO/ODATANO" className="hover:text-(--foreground)" target="_blank" rel="noreferrer">ODATANO</a>
              {' · '}
              <a href="https://www.x402.org" className="hover:text-(--foreground)" target="_blank" rel="noreferrer">x402</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}

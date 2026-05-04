import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

// Build-time branding for static metadata (HTML <title>, OG tags).
// Each tenant sets these in their Vercel project env. Runtime UI
// branding (the company-name banner inside the app shell) is driven
// by the in-DB `branding.company_name` setting via useAppSettings —
// see apps/web/src/lib/use-app-settings.ts.
const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME ?? 'BullionOS';

export const metadata: Metadata = {
  title: `${BRAND_NAME} Portal`,
  description: `${BRAND_NAME} CRM + Client Portal`,
  // Point browsers at the API favicon endpoint. Vercel rewrites /api/* to
  // the Railway origin, so the favicon survives deploys along with the
  // logo (both stored in the DB as BYTEA). The ?v=1 lets admins force a
  // refresh by bumping it on the upload response; cache headers hold the
  // browser to 60s otherwise.
  icons: {
    icon: '/api/v1/public/branding/favicon',
    shortcut: '/api/v1/public/branding/favicon',
    apple: '/api/v1/public/branding/favicon',
  },
};

// Privacy policy URL — tenant-specific (per-deploy env var) since the
// hosted policy lives on each operator's own marketing site. Hidden
// when unset, so a fresh tenant doesn't ship a broken link.
const PRIVACY_URL = process.env.NEXT_PUBLIC_PRIVACY_URL ?? '';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased font-sans">
        <Providers>{children}</Providers>
        {/*
         * Privacy policy link — kept on every page at the root level so
         * Google's OAuth consent-screen verifier (which crawls the app's
         * "Application home page") can discover it. Must be a real,
         * crawlable anchor — `display: none`, `visibility: hidden`, and
         * aria-hidden are all treated as cloaking by Google and will fail
         * verification. Small gray text in a fixed-position footer is the
         * standard unobtrusive-but-visible pattern.
         */}
        {PRIVACY_URL && (
          <footer className="pointer-events-none fixed inset-x-0 bottom-0 z-0 flex justify-end px-3 py-1 text-[10px] leading-none text-ink-300">
            <a
              href={PRIVACY_URL}
              rel="noopener"
              className="pointer-events-auto hover:text-ink-500 hover:underline"
            >
              Privacy policy
            </a>
          </footer>
        )}
      </body>
    </html>
  );
}

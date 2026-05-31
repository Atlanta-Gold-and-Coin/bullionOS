/**
 * BullionOS brand assets — three inline-SVG components:
 *
 *   - <BullionOSLogo>      Compact "ring + bar" mark for sidebar tiles.
 *   - <BullionOSWordmark>  Lowercase "bullionOS" wordmark, with optional
 *                          "Precious Metals · Powered by Software" tagline.
 *   - <BullionOSHeroMark>  Elaborate hexagon + circuit-traces + 3D bar
 *                          for splash surfaces (login page).
 *
 * All drawn as inline SVG so they scale cleanly and the gold gradient
 * stays sharp at any size — no raster bitmap dep.
 *
 * Plus one branding-aware wrapper:
 *
 *   - <BrandedLogo>        Renders the tenant's uploaded logo when the
 *                          branding payload reports one, else falls back
 *                          to the inline <BullionOSLogo> mark. Use this
 *                          in the app chrome so white-label tenants show
 *                          their own mark; default (no logo uploaded)
 *                          reproduces today's look byte-for-byte.
 */

'use client';

import { useAppSettings } from '@/lib/use-app-settings';

export function BullionOSLogo({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="BullionOS"
    >
      <defs>
        <linearGradient id="bos-bar-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f3d266" />
          <stop offset="55%" stopColor="#e7b934" />
          <stop offset="100%" stopColor="#b08e4a" />
        </linearGradient>
        <linearGradient id="bos-ring-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e7b934" />
          <stop offset="100%" stopColor="#b08e4a" />
        </linearGradient>
      </defs>
      {/* Orbit ring */}
      <circle cx="32" cy="32" r="26" stroke="url(#bos-ring-grad)" strokeWidth="2" fill="none" />
      {/* Two satellite dots — top-left + bottom-right of the orbit. */}
      <circle cx="13" cy="13" r="2" fill="#e7b934" />
      <circle cx="51" cy="51" r="2" fill="#e7b934" />
      {/* Gold bar — front face (trapezoid) + top face (parallelogram). */}
      <path
        d="M18 30 L46 30 L42 42 L22 42 Z"
        fill="url(#bos-bar-grad)"
        stroke="#8b6f2c"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path
        d="M18 30 L22 24 L46 24 L42 30 Z"
        fill="#f3d266"
        stroke="#8b6f2c"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BullionOSWordmark({
  withTagline = false,
  className = '',
  size = 'base',
}: {
  withTagline?: boolean;
  className?: string;
  size?: 'sm' | 'base' | 'lg';
}) {
  const wordCls =
    size === 'lg'
      ? 'text-3xl'
      : size === 'sm'
        ? 'text-xs'
        : 'text-base';
  return (
    <div className={'text-center ' + className}>
      <div className={'font-semibold tracking-tight ' + wordCls}>
        <span className="text-white">bullion</span>
        <span className="text-gold-400">OS</span>
      </div>
      {withTagline && (
        <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.18em] text-bos-text">
          Precious Metals · Powered by Software
        </div>
      )}
    </div>
  );
}

export function BullionOSHeroMark({
  size = 160,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="BullionOS"
    >
      <defs>
        <linearGradient id="bos-hero-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f3d266" />
          <stop offset="50%" stopColor="#e7b934" />
          <stop offset="100%" stopColor="#a87f23" />
        </linearGradient>
        <linearGradient id="bos-hero-bar" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#f3d266" />
          <stop offset="55%" stopColor="#e7b934" />
          <stop offset="100%" stopColor="#9a7421" />
        </linearGradient>
        <linearGradient id="bos-hero-bar-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f7dc7d" />
          <stop offset="100%" stopColor="#e7b934" />
        </linearGradient>
      </defs>

      {/* Hexagonal frame (flat top + bottom). Drawn as separate
          segments so the bottom-right side can stay open where the
          circuit traces splice in. */}
      <g
        stroke="url(#bos-hero-gold)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M70 32 L130 32" />
        <path d="M130 32 L160 64" />
        <path d="M160 64 L160 96" />
        <path d="M70 32 L40 64" />
        <path d="M40 64 L40 136" />
        <path d="M40 136 L70 168" />
        <path d="M70 168 L100 168" />
      </g>

      {/* Circuit traces with circular endpoints, splicing in where
          the hex outline opens (right + bottom). */}
      <g
        stroke="url(#bos-hero-gold)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M160 96 L172 96 L172 80" />
        <path d="M160 96 L160 130 L150 140" />
        <path d="M100 168 L120 168 L130 178" />
      </g>
      <g fill="#e7b934">
        <circle cx="172" cy="74" r="6" stroke="#8b6f2c" strokeWidth="1.5" />
        <circle cx="146" cy="146" r="6" stroke="#8b6f2c" strokeWidth="1.5" />
        <circle cx="134" cy="182" r="6" stroke="#8b6f2c" strokeWidth="1.5" />
      </g>

      {/* 3D gold bar — top + front + right facets for the volumetric read. */}
      <path
        d="M68 84 L86 70 L138 70 L120 84 Z"
        fill="url(#bos-hero-bar-top)"
        stroke="#7c601f"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M68 84 L120 84 L114 124 L74 124 Z"
        fill="url(#bos-hero-bar)"
        stroke="#7c601f"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M120 84 L138 70 L130 110 L114 124 Z"
        fill="#a17a23"
        stroke="#7c601f"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}

/**
 * Branding-aware mark. When the tenant has uploaded a logo
 * (branding.has_logo) it renders that bitmap from the public branding
 * endpoint; otherwise it falls back to the inline <BullionOSLogo> SVG
 * so the default (un-customized) deploy looks exactly as it does today.
 *
 * `size` controls both the SVG fallback and the rendered <img> box
 * (square, object-contain so non-square logos letterbox rather than
 * distort). `alt` defaults to the tenant company name when known.
 */
export function BrandedLogo({
  size = 32,
  className,
  alt,
}: {
  size?: number;
  className?: string;
  alt?: string;
}) {
  const { data } = useAppSettings();
  const branding = data?.branding;

  if (branding?.has_logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- served
      // from the API proxy (BYTEA), not the Next image pipeline.
      <img
        src={branding.logo_url ?? '/api/v1/public/branding/logo'}
        alt={alt ?? branding.company_name ?? 'Logo'}
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
    );
  }

  return <BullionOSLogo size={size} className={className} />;
}

'use client'

import logoWordSvg from '@assets/logo-word.svg' with { type: 'text' }

export function Logo({ className }: { className?: string }) {
  return (
    <div
      className={`logo-word ${className ?? ''}`}
      role="img"
      aria-label="Duron"
      dangerouslySetInnerHTML={{ __html: logoWordSvg }}
    />
  )
}

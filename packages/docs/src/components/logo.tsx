import logoWordSvg from '@assets/logo-word.svg?raw'

export function Logo({ className }: { className: string }) {
  return (
    <div
      className={`logo-word ${className}`}
      role="img"
      aria-label="Duron"
      dangerouslySetInnerHTML={{ __html: logoWordSvg }}
    />
  )
}

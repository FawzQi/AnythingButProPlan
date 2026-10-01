import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sky-600 hover:bg-sky-500 text-white',
  secondary: 'bg-[#2a2f38] hover:bg-[#343a45] text-slate-100',
  ghost: 'bg-transparent hover:bg-[#2a2f38] text-slate-200',
  danger: 'bg-red-700 hover:bg-red-600 text-white',
}

/**
 * Base button. The `shrink-0` and `whitespace-nowrap` are load-bearing, not
 * cosmetic.
 *
 * Every action row in the app is a `flex` container with `flex-wrap`, and a
 * flex item shrinks by default (`flex-shrink: 1`) when the row runs out of
 * width. A button's natural width comes from its label, so on a row that is
 * slightly too narrow the buttons compress before the row wraps — the
 * browser shrinks each item toward its `min-content` width, which for a
 * button with `px-3` horizontal padding is just the padding itself. The
 * label is still in the DOM but is clipped to invisibility, so the button
 * renders as a small empty rounded rectangle.
 *
 * This is font-metric-dependent, which is why it shows up on Windows and
 * not on Linux. Segoe UI (Windows) is slightly wider than DejaVu Sans
 * (typical Linux), so the Prompt tab's action row — `2 / 102 selected` plus
 * four buttons — sits just over the header width on Windows and just under
 * it on Linux. The Linux build wraps the row onto a second line and looks
 * correct; the Windows build squeezes the buttons instead, and `Copy` and
 * `Save` end up as the tiny blank pills in the screenshot.
 *
 * `shrink-0` forbids the compression, so the row must wrap instead of
 * squeezing — which is the correct behaviour and what the wrap on the
 * container is there for. `whitespace-nowrap` stops a two-word label from
 * breaking across lines when the button is genuinely narrow, so a label
 * like "Send to web chat" stays on one line rather than becoming a
 * two-line box the same height as its neighbours.
 */
export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): ReactNode {
  return (
    <button
      type="button"
      {...props}
      className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Panel({
  title,
  actions,
  children,
  className = '',
  style,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  style?: CSSProperties
}): ReactNode {
  return (
    <section
      style={style}
      className={`flex min-h-0 flex-col overflow-hidden border-[#2c3038] ${className}`}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#2c3038] px-3 py-2">
        <h2 className="shrink-0 text-xs font-semibold tracking-wide text-slate-400 uppercase">{title}</h2>
        {/* `ml-auto` right-aligns the actions both on the same line as the
            title and on its own wrapped line, which `justify-between` cannot
            do once flex-wrap splits the two into separate rows. */}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  )
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success'
  children: ReactNode
}): ReactNode {
  const tones = {
    info: 'border-sky-800 bg-sky-950/50 text-sky-200',
    warn: 'border-amber-800 bg-amber-950/50 text-amber-200',
    error: 'border-red-800 bg-red-950/50 text-red-200',
    success: 'border-emerald-800 bg-emerald-950/50 text-emerald-200',
  } as const
  return (
    <div className={`rounded border px-3 py-2 text-xs ${tones[tone]}`}>{children}</div>
  )
}

/**
 * Draggable divider between two resizable panels. Purely presentational: the
 * parent owns the width state and supplies the mousedown handler.
 */
export function ResizeHandle({
  onMouseDown,
  label,
}: {
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void
  label: string
}): ReactNode {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-[#2c3038] transition-colors hover:bg-sky-600 active:bg-sky-500"
    />
  )
}
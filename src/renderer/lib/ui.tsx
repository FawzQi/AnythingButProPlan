import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sky-600 hover:bg-sky-500 text-white',
  secondary: 'bg-[#2a2f38] hover:bg-[#343a45] text-slate-100',
  ghost: 'bg-transparent hover:bg-[#2a2f38] text-slate-200',
  danger: 'bg-red-700 hover:bg-red-600 text-white',
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): ReactNode {
  return (
    <button
      type="button"
      {...props}
      className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}): ReactNode {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-200">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-sky-500"
      />
      {label ? <span className="truncate">{label}</span> : null}
    </label>
  )
}

export function Panel({
  title,
  actions,
  children,
  className = '',
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden border-[#2c3038] ${className}`}>
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

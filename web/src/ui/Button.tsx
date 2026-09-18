import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

// Minimum 44px touch target. A filled button uses the darker brand orange, because
// white on #ff7a2f is 2.6:1 — the brand orange itself stays for tints and accents.
const base =
  'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-4 text-[15px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-strong text-on-brand-strong hover:bg-brand-strong-hover',
  secondary: 'border border-line bg-raised text-ink hover:bg-sunken',
  ghost: 'text-ink hover:bg-sunken',
  // The surface token flips with the theme, so the label stays readable on the red fill.
  danger: 'bg-danger text-surface hover:opacity-90',
};

export function Button({ variant = 'primary', className = '', children, type = 'button', ref, ...rest }: ButtonProps) {
  return (
    <button ref={ref} type={type} className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

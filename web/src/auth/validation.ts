/**
 * Form validation for the auth screens.
 *
 * Password rules mirror the Supabase project settings (minimum 8 characters, letters
 * and digits). Messages say what to do, not what went wrong grammatically.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RULE_HINT = 'At least 8 characters, including a letter and a number.';

export type AuthField = 'email' | 'password';

export type FieldErrors = Partial<Record<AuthField, string>>;

/** Fields in DOM order, so the error summary lists problems the way the form reads. */
export const FIELD_ORDER: readonly AuthField[] = ['email', 'password'];

// Deliberately permissive: the server is the authority on deliverability.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

export function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (!email) return 'Enter your email address.';
  if (email.length > MAX_EMAIL_LENGTH) return 'That email address is too long.';
  if (!EMAIL_PATTERN.test(email)) return 'Enter an email address like name@example.com.';
  return undefined;
}

export function validateNewPassword(value: string): string | undefined {
  if (!value) return 'Choose a password.';
  if (value.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) return 'Include at least one letter and one number.';
  return undefined;
}

export function validateExistingPassword(value: string): string | undefined {
  return value ? undefined : 'Enter your password.';
}

export interface AuthFormValues {
  email: string;
  password: string;
}

/** Validates the whole form; an empty object means it can be submitted. */
export function validateAuthForm(values: AuthFormValues, mode: 'signin' | 'signup'): FieldErrors {
  const errors: FieldErrors = {};
  const emailError = validateEmail(values.email);
  if (emailError) errors.email = emailError;

  const passwordError = mode === 'signup' ? validateNewPassword(values.password) : validateExistingPassword(values.password);
  if (passwordError) errors.password = passwordError;

  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return FIELD_ORDER.some((field) => errors[field] !== undefined);
}

export interface SummaryItem {
  field: AuthField;
  message: string;
}

/** Error summary contents, ordered like the form. */
export function toSummaryItems(errors: FieldErrors): SummaryItem[] {
  return FIELD_ORDER.flatMap((field) => {
    const message = errors[field];
    return message ? [{ field, message }] : [];
  });
}

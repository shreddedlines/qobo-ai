import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { useAuth } from '../../auth/AuthProvider.tsx';
import type { AuthFailure } from '../../auth/errors.ts';
import { CHAT_PATH } from '../../auth/guards.ts';
import { buildSummaryItems } from '../../auth/summary.ts';
import {
  PASSWORD_RULE_HINT,
  hasErrors,
  validateAuthForm,
  validateEmail,
  validateExistingPassword,
  validateNewPassword,
  type AuthField,
  type FieldErrors,
} from '../../auth/validation.ts';
import { Button } from '../../ui/Button.tsx';
import { ErrorSummary, type ErrorSummaryItem } from '../../ui/ErrorSummary.tsx';
import { Field } from '../../ui/Field.tsx';

export interface AuthPageProps {
  mode: 'signin' | 'signup';
}

const FIELD_IDS: Record<AuthField, string> = { email: 'email', password: 'password' };

export function AuthPage({ mode }: AuthPageProps) {
  const isSignIn = mode === 'signin';
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const intendedPath = (location.state as { from?: string } | null)?.from;

  const [values, setValues] = useState({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formFailure, setFormFailure] = useState<AuthFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);
  // Bumped on every failed submit so focus moves to the summary again.
  const [failedSubmits, setFailedSubmits] = useState(0);
  // The summary opens only after a failed submit: opening it mid-typing would push the
  // submit button down while the pointer is already on its way to it.
  const [showSummary, setShowSummary] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (failedSubmits > 0) summaryRef.current?.focus();
  }, [failedSubmits]);

  const validateField = (field: AuthField, value: string): string | undefined => {
    if (field === 'email') return validateEmail(value);
    return isSignIn ? validateExistingPassword(value) : validateNewPassword(value);
  };

  const summaryItems: ErrorSummaryItem[] = buildSummaryItems({ fieldErrors, formFailure, showSummary }).map((item) => ({
    ...(item.field ? { fieldId: FIELD_IDS[item.field] } : {}),
    message: item.message,
  }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const errors = validateAuthForm(values, mode);
    setFormFailure(null);
    setFieldErrors(errors);
    if (hasErrors(errors)) {
      setShowSummary(true);
      setFailedSubmits((count) => count + 1);
      return;
    }

    setSubmitting(true);
    const result = isSignIn ? await signIn(values) : await signUp(values);
    setSubmitting(false);

    if (!result.ok) {
      const { failure } = result;
      if (failure.field) setFieldErrors({ [failure.field]: failure.message });
      setFormFailure(failure);
      setShowSummary(true);
      setFailedSubmits((count) => count + 1);
      return;
    }

    if (!isSignIn && result.needsConfirmation) {
      setConfirmationSentTo(values.email.trim());
      return;
    }
    navigate(intendedPath ?? CHAT_PATH, { replace: true });
  }

  if (confirmationSentTo) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <div className="measure w-full" role="status">
          <h1 className="font-display text-2xl font-semibold text-ink">Confirm your email</h1>
          <p className="mt-3 text-[15px] text-muted">
            We sent a confirmation link to <span className="font-medium text-ink">{confirmationSentTo}</span>. Open it, then sign in.
          </p>
          <Link to="/login" className="mt-6 inline-block font-medium text-ink underline underline-offset-2">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <div className="measure w-full">
        <h1 className="font-display text-2xl font-semibold text-ink">{isSignIn ? 'Sign in to QOBO Support' : 'Create your QOBO account'}</h1>
        <p className="mt-2 text-[15px] text-muted">
          {isSignIn ? 'Your conversations stay private to your account.' : 'Ask QOBO about websites, marketing and automation, and keep your chat history.'}
        </p>

        <form noValidate onSubmit={handleSubmit} aria-busy={submitting} className="mt-8 flex flex-col gap-5">
          <ErrorSummary ref={summaryRef} items={summaryItems} />

          <Field
            id={FIELD_IDS.email}
            label="Email address"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            value={values.email}
            error={fieldErrors.email}
            disabled={submitting}
            onChange={(event) => {
              setValues((current) => ({ ...current, email: event.target.value }));
              setShowSummary(false);
              if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
            }}
            onBlur={(event) => setFieldErrors((current) => ({ ...current, email: validateField('email', event.target.value) }))}
          />

          <Field
            id={FIELD_IDS.password}
            label="Password"
            type="password"
            autoComplete={isSignIn ? 'current-password' : 'new-password'}
            {...(isSignIn ? {} : { description: PASSWORD_RULE_HINT })}
            value={values.password}
            error={fieldErrors.password}
            disabled={submitting}
            onChange={(event) => {
              setValues((current) => ({ ...current, password: event.target.value }));
              setShowSummary(false);
              if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
            }}
            onBlur={(event) => setFieldErrors((current) => ({ ...current, password: validateField('password', event.target.value) }))}
          />

          <Button type="submit" disabled={submitting} className="mt-1 w-full">
            {submitting ? (isSignIn ? 'Signing in…' : 'Creating account…') : isSignIn ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="mt-6 text-[15px] text-muted">
          {isSignIn ? (
            <>
              New to QOBO Support?{' '}
              <Link to="/signup" state={location.state} className="font-medium text-ink underline underline-offset-2">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link to="/login" state={location.state} className="font-medium text-ink underline underline-offset-2">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

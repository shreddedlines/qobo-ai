import type { Source } from '../conversations/types.ts';

/**
 * Contact details as published on https://qobo.dev/contact-us (verified against the
 * reviewed snapshot by tests). Used in deterministic fallback and guard messages,
 * which must never depend on model output.
 */
export const QOBO_CONTACT = {
  whatsappDisplay: '+91 99016 31188',
  whatsappUrl: 'https://wa.me/919901631188',
  phoneDisplay: '+91 99011 41616',
  email: 'hello@qobo.dev',
} as const;

export const CONTACT_SOURCE: Source = { title: 'Contact QOBO', url: 'https://qobo.dev/contact-us', kind: 'qobo' };

export function contactSentence(): string {
  return `You can reach the QOBO team on WhatsApp at ${QOBO_CONTACT.whatsappDisplay} (${QOBO_CONTACT.whatsappUrl}) or by email at ${QOBO_CONTACT.email}.`;
}

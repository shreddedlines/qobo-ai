import { contactSentence } from './qobo-facts.ts';

/**
 * Known contradictions on qobo.dev, reviewed by a human. The answer pipeline must
 * not silently pick one version. Quotes are verbatim from kb/snapshots (a test
 * fails if the site text they reference disappears from the snapshots).
 *
 * Kept as TypeScript data inside api/ so it ships with the API build.
 */
export interface DiscrepancyStatement {
  title: string;
  url: string;
  quote: string;
}

export interface Discrepancy {
  id: string;
  /** Question patterns (case-insensitive) that make this discrepancy relevant. */
  queryPatterns: RegExp[];
  /** Retrieved text containing any of these markers also makes it relevant. */
  contentMarkers: string[];
  /** The answer must mention one of these before the guard considers it on-topic. */
  answerPatterns: RegExp[];
  statements: DiscrepancyStatement[];
  /** Facts every relevant page agrees on. */
  consistentFacts: string[];
  /** Instructions for the model. */
  guidance: string;
  /** Whether an on-topic answer followed the guidance; otherwise `userNote` is appended. */
  isCompliant: (answer: string) => boolean;
  /** Deterministic note appended when the model's answer ignores the guidance. */
  userNote: string;
}

const RECOMMENDS_CONFIRMING = /\bconfirm|check with|verify with|(?:contact|ask|reach out to|talk to|message) (?:our|the) (?:qobo )?team/i;
const MENTIONS_MONTHLY = /\bmonthly\b|per month|\/\s?month|\/mo\b|a month\b/i;
const MENTIONS_ONE_TIME = /one[- ]time|\blifetime\b|no recurring|own it forever|pay once|single payment/i;

export const DISCREPANCIES: Discrepancy[] = [
  {
    id: 'starter-plan-billing',
    queryPatterns: [
      /₹\s?\d/,
      /\b(?:rs\.?|inr|rupees?)\b/,
      /\b499\b|\b999\b/,
      /\bpric(?:e|es|ing)\b|\bcosts?\b|how much|\bfees?\b|\bcharges?\b|\bbilling\b|\bbilled\b/,
      /\bplans?\b|\bstarter\b|\bsubscri(?:be|ption)\b|\btrial\b/,
      /\bmonthly\b|per month|\/month|one[- ]time|\blifetime\b|\brecurring\b|\brenew/,
      /\bkitna\b|\bkitne\b|\bpaise\b|कीमत|दाम|कितना|कितने|पैसे/,
    ],
    contentMarkers: ['₹499/month', 'one-time investment', 'No recurring subscriptions', 'Own it forever'],
    answerPatterns: [
      /₹\s?499|\b499\b/,
      /\bpric(?:e|es|ing)\b|\bcosts?\b|subscri|\bmonthly\b|per month|one[- ]time|\blifetime\b|\bbilling\b|\bbilled\b|starter plan|paid plans?|pay only when/i,
    ],
    statements: [
      {
        title: 'Plans & Pricing',
        url: 'https://qobo.dev/plans',
        quote: "Whether it's the ₹499 starter or a Custom build, you own the code and the domain. No recurring subscriptions, just a one-time investment for a lifetime asset.",
      },
      {
        title: 'QOBO Home',
        url: 'https://qobo.dev/',
        quote: 'Yes! Build and preview your site for free. Pay only when you go live, starting at ₹499/month. No hidden fees.',
      },
      {
        title: 'WhatsApp Website Builder',
        url: 'https://qobo.dev/whatsapp-website-builder',
        quote: 'Yes! Build and preview your site for free. Pay only when you go live, starting at ₹499/month.',
      },
    ],
    consistentFacts: [
      'The Plans page lists a Trial plan at ₹0 ("1 Prompt. No Updates."), a Starter plan at ₹499, a Pro plan at ₹999 ("Advanced SEO & High Priority.") and a Custom plan ("Enterprise Grade Solutions.").',
      'Both the Plans page and the FAQs say you can start for free and that paid plans start at ₹499.',
    ],
    guidance:
      'QOBO\'s website describes how the ₹499 Starter plan is billed in two different ways: the Plans page calls it a one-time investment with no recurring subscription, while FAQ answers say "starting at ₹499/month". Do NOT say the plan is one-time, lifetime, monthly or a subscription. Share the facts every page agrees on, mention that the website describes the billing terms differently on different pages, and recommend confirming the current billing terms with the QOBO team before paying. Cite the relevant sources.',
    // Compliant: recommends confirming, and does not present only one billing model.
    isCompliant: (answer) => RECOMMENDS_CONFIRMING.test(answer) && MENTIONS_MONTHLY.test(answer) === MENTIONS_ONE_TIME.test(answer),
    userNote: `**Note on billing:** QOBO's website describes the ₹499 Starter plan's billing differently on different pages (a one-time payment on the Plans page, "starting at ₹499/month" in the FAQs). Please confirm the current billing terms with our team before you pay. ${contactSentence()}`,
  },
  {
    id: 'websites-created-count',
    queryPatterns: [/how many (?:websites|sites|customers|clients|businesses)|number of (?:websites|sites|customers|clients)|websites (?:created|launched|built)/i],
    contentMarkers: ['WEBSITES CREATED ON QOBO', 'WEBSITES LAUNCHED'],
    answerPatterns: [/\b[15],000\+?\s*(?:websites|sites)|websites (?:created|launched)/i],
    statements: [
      { title: 'QOBO Home', url: 'https://qobo.dev/', quote: '1,000+ WEBSITES CREATED ON QOBO' },
      { title: 'WhatsApp Website Builder', url: 'https://qobo.dev/whatsapp-website-builder', quote: '5,000+ WEBSITES LAUNCHED' },
    ],
    consistentFacts: ['Both pages present the number of websites as a marketing figure.'],
    guidance:
      'QOBO\'s website shows different figures for how many websites have been built (1,000+ on the home page, 5,000+ on the WhatsApp Website Builder page). Do not state a single precise number as fact. If asked, say the website mentions both figures on different pages and attribute them to the website.',
    // Compliant: mentions both figures or neither.
    isCompliant: (answer) => /1,?000\+/.test(answer) === /5,?000\+/.test(answer),
    userNote:
      '**Note:** QOBO\'s website shows different figures for this on different pages ("1,000+ websites created" on the home page and "5,000+ websites launched" on the WhatsApp Website Builder page). These are marketing figures from the website.',
  },
];

export interface RetrievedText {
  content: string;
}

/** Discrepancies relevant to this question or to the retrieved text. */
export function findRelevantDiscrepancies(question: string, retrieved: RetrievedText[], discrepancies: Discrepancy[] = DISCREPANCIES): Discrepancy[] {
  const normalizedQuestion = question.toLowerCase();
  return discrepancies.filter(
    (discrepancy) =>
      discrepancy.queryPatterns.some((pattern) => pattern.test(normalizedQuestion)) ||
      retrieved.some((chunk) => discrepancy.contentMarkers.some((marker) => chunk.content.includes(marker))),
  );
}

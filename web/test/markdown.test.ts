import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInline, parseMarkdown, safeHref, type Inline } from '../src/chat/markdown.ts';

const text = (value: string): Inline => ({ type: 'text', value });

describe('safeHref', () => {
  it('accepts http and https only', () => {
    assert.equal(safeHref('https://qobo.dev/pricing'), 'https://qobo.dev/pricing');
    assert.equal(safeHref(' http://qobo.dev '), 'http://qobo.dev/');
    for (const value of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'not a url', '//qobo.dev']) {
      assert.equal(safeHref(value), null, value);
    }
  });
});

describe('inline parsing', () => {
  it('reads bold, italic and inline code', () => {
    assert.deepEqual(parseInline('**Starter** is *₹499* per `month`'), [
      { type: 'strong', children: [text('Starter')] },
      text(' is '),
      { type: 'em', children: [text('₹499')] },
      text(' per '),
      { type: 'code', value: 'month' },
    ]);
  });

  it('does not treat snake_case or a lone asterisk as emphasis', () => {
    assert.deepEqual(parseInline('call get_kb_meta now'), [text('call get_kb_meta now')]);
    assert.deepEqual(parseInline('2 * 3 = 6'), [text('2 * 3 = 6')]);
  });

  it('links markdown links and bare urls, without their trailing punctuation', () => {
    assert.deepEqual(parseInline('See [pricing](https://qobo.dev/pricing).'), [
      text('See '),
      { type: 'link', href: 'https://qobo.dev/pricing', children: [text('pricing')] },
      text('.'),
    ]);
    assert.deepEqual(parseInline('Read https://qobo.dev/about, then decide.'), [
      text('Read '),
      { type: 'link', href: 'https://qobo.dev/about', children: [text('https://qobo.dev/about')] },
      text(', then decide.'),
    ]);
  });

  it('refuses a dangerous link target and keeps the text', () => {
    assert.deepEqual(parseInline('[click](javascript:alert(1))'), [text('[click](javascript:alert(1))')]);
  });

  it('leaves raw html as literal text, so nothing can be injected', () => {
    assert.deepEqual(parseInline('<img src=x onerror="alert(1)"> and <b>bold</b>'), [
      text('<img src=x onerror="alert(1)"> and <b>bold</b>'),
    ]);
  });

  it('keeps a citation marker inside inline code literal', () => {
    assert.deepEqual(parseInline('`[1]` is a marker'), [{ type: 'code', value: '[1]' }, text(' is a marker')]);
  });
});

describe('citation markers', () => {
  it('reads a single marker', () => {
    assert.deepEqual(parseInline('Starter costs ₹499 [1].'), [text('Starter costs ₹499 '), { type: 'citation', numbers: [1] }, text('.')]);
  });

  it('groups adjacent markers into one run and drops duplicates', () => {
    assert.deepEqual(parseInline('Both pages agree [1][2].'), [text('Both pages agree '), { type: 'citation', numbers: [1, 2] }, text('.')]);
    assert.deepEqual(parseInline('Spaced [1] [2] too'), [text('Spaced '), { type: 'citation', numbers: [1, 2] }, text('too')]);
    assert.deepEqual(parseInline('Repeated [2][2]'), [text('Repeated '), { type: 'citation', numbers: [2] }]);
  });

  it('keeps markers apart when prose sits between them', () => {
    assert.deepEqual(parseInline('One [1] and two [2]'), [
      text('One '),
      { type: 'citation', numbers: [1] },
      text('and two '),
      { type: 'citation', numbers: [2] },
    ]);
  });

  it('ignores bracketed text that is not a citation', () => {
    assert.deepEqual(parseInline('[starter-plan-billing] and [note]'), [text('[starter-plan-billing] and [note]')]);
    assert.deepEqual(parseInline('an escaped \\[1] marker'), [text('an escaped [1] marker')]);
  });
});

describe('block parsing', () => {
  it('splits paragraphs on blank lines and joins wrapped lines', () => {
    assert.deepEqual(parseMarkdown('First line\nsame paragraph\n\nSecond one'), [
      { type: 'paragraph', children: [text('First line same paragraph')] },
      { type: 'paragraph', children: [text('Second one')] },
    ]);
  });

  it('reads bullet and numbered lists, including wrapped items', () => {
    assert.deepEqual(parseMarkdown('- Websites\n- Online stores\n  built fast'), [
      { type: 'list', ordered: false, items: [[text('Websites')], [text('Online stores built fast')]] },
    ]);
    assert.deepEqual(parseMarkdown('1. Ask\n2. Approve'), [{ type: 'list', ordered: true, items: [[text('Ask')], [text('Approve')]] }]);
  });

  it('clamps headings to h2 and h3 so the page outline stays intact', () => {
    assert.deepEqual(parseMarkdown('# Plans\n### Starter\n###### Deep'), [
      { type: 'heading', level: 2, children: [text('Plans')] },
      { type: 'heading', level: 3, children: [text('Starter')] },
      { type: 'heading', level: 3, children: [text('Deep')] },
    ]);
  });

  it('reads fenced code verbatim and quotes', () => {
    assert.deepEqual(parseMarkdown('```\nline **1**\nline 2\n```'), [{ type: 'code', value: 'line **1**\nline 2' }]);
    assert.deepEqual(parseMarkdown('> QOBO builds via WhatsApp\n> in days'), [
      { type: 'quote', children: [text('QOBO builds via WhatsApp in days')] },
    ]);
  });

  it('returns nothing for empty or whitespace-only content', () => {
    assert.deepEqual(parseMarkdown(''), []);
    assert.deepEqual(parseMarkdown('   \n\n  '), []);
  });

  it('handles a realistic reply end to end', () => {
    const blocks = parseMarkdown('QOBO builds websites over **WhatsApp** [1].\n\n- Starter is ₹499 [2]\n- SEO is included [1][2]');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]?.type, 'paragraph');
    assert.equal(blocks[1]?.type, 'list');
    const list = blocks[1] as { items: Inline[][] };
    assert.deepEqual(list.items[1]?.at(-1), { type: 'citation', numbers: [1, 2] });
  });
});

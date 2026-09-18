import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInline, parseMarkdown, safeHref, stripCitations, withoutCitations, type Inline } from '../src/chat/markdown.ts';

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

describe('stripping citation markers from a reply', () => {
  /** The rendered text of a run, which is what a reader actually sees. */
  const flatten = (nodes: readonly Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
            return node.value;
          case 'code':
            return node.value;
          case 'citation':
            return `[${node.numbers.join('][')}]`;
          default:
            return flatten(node.children);
        }
      })
      .join('');

  const rendered = (markdown: string): string =>
    withoutCitations(parseMarkdown(markdown))
      .map((block) => {
        if (block.type === 'code') return block.value;
        if (block.type === 'list') return block.items.map(flatten).join(' | ');
        return flatten(block.children);
      })
      .join('\n');

  it('removes a marker and closes the gap before the punctuation', () => {
    assert.equal(rendered('Starter costs ₹499 [1].'), 'Starter costs ₹499.');
    assert.equal(rendered('Both pages agree [1][2].'), 'Both pages agree.');
  });

  it('keeps sentences readable when markers sit mid-sentence', () => {
    assert.equal(rendered('We offer plans [1] and SEO [2] too.'), 'We offer plans and SEO too.');
    assert.equal(rendered('A one-time asset [1], while FAQs say ₹499/month [2] [3]).'), 'A one-time asset, while FAQs say ₹499/month).');
  });

  it('leaves the rest of the formatting alone', () => {
    const blocks = withoutCitations(parseMarkdown('**Starter** is *₹499* per `month` [1].'));
    assert.deepEqual(blocks, [
      {
        type: 'paragraph',
        children: [
          { type: 'strong', children: [text('Starter')] },
          text(' is '),
          { type: 'em', children: [text('₹499')] },
          text(' per '),
          { type: 'code', value: 'month' },
          text('.'),
        ],
      },
    ]);
  });

  it('strips markers inside lists, headings, quotes and links', () => {
    assert.equal(rendered('- Starter is ₹499 [2]\n- SEO is included [1][2]'), 'Starter is ₹499 | SEO is included');
    assert.equal(rendered('## Plans [1]'), 'Plans');
    assert.equal(rendered('> QOBO builds via WhatsApp [1]'), 'QOBO builds via WhatsApp');
    assert.equal(rendered('See [pricing](https://qobo.dev/plans) [1].'), 'See pricing.');
  });

  it('never leaves a stray marker behind', () => {
    const answer = 'Plans [1][2]. FAQs mention ₹499/month [2] [3], see [1].';
    assert.ok(!/\[\d+\]/.test(rendered(answer)), rendered(answer));
  });

  it('drops a block that held nothing but a marker', () => {
    assert.deepEqual(withoutCitations(parseMarkdown('[1]')), []);
    assert.deepEqual(withoutCitations(parseMarkdown('Real answer.\n\n[1]')), [
      { type: 'paragraph', children: [text('Real answer.')] },
    ]);
  });

  it('leaves fenced code untouched, markers and all', () => {
    assert.deepEqual(withoutCitations(parseMarkdown('```\nvalue = [1]\n```')), [{ type: 'code', value: 'value = [1]' }]);
  });

  it('is a no-op for a reply with no markers', () => {
    const blocks = parseMarkdown('QOBO builds websites over WhatsApp.');
    assert.deepEqual(withoutCitations(blocks), blocks);
  });

  it('exposes the inline transform on its own, spacing repaired', () => {
    assert.deepEqual(stripCitations(parseInline('Plans [1] and SEO [2].')), [text('Plans and SEO.')]);
    assert.deepEqual(stripCitations([]), []);
  });
});

describe('removing a marker never doubles up punctuation', () => {
  const flatten = (nodes: readonly Inline[]): string =>
    nodes.map((node) => (node.type === 'text' ? node.value : node.type === 'code' ? node.value : 'children' in node ? flatten(node.children) : '')).join('');
  const rendered = (markdown: string): string =>
    withoutCitations(parseMarkdown(markdown))
      .map((block) => (block.type === 'code' ? block.value : block.type === 'list' ? block.items.map(flatten).join(' | ') : flatten(block.children)))
      .join('\n');

  it('fixes the reported SEO vs SEM answer, both spacings', () => {
    assert.equal(
      rendered('SEO focuses on organic content,[1], while SEM uses paid ads.'),
      'SEO focuses on organic content, while SEM uses paid ads.',
    );
    assert.equal(
      rendered('SEO focuses on organic content, [1], whereas SEM uses paid ads.'),
      'SEO focuses on organic content, whereas SEM uses paid ads.',
    );
  });

  it('keeps one mark when the same one sits on both sides of a marker', () => {
    assert.equal(rendered('Plans start at ₹499.[1]. See the page.'), 'Plans start at ₹499. See the page.');
    assert.equal(rendered('Great news![1]! Really.'), 'Great news! Really.');
    assert.equal(rendered('Is it free?[1]? Yes.'), 'Is it free? Yes.');
    assert.equal(rendered('SEO is organic;[1]; SEM is paid.'), 'SEO is organic; SEM is paid.');
    assert.equal(rendered('Two options:[1]: Starter and Pro.'), 'Two options: Starter and Pro.');
  });

  it('keeps the stronger mark when the two differ', () => {
    assert.equal(rendered('Organic content,[1]. Paid ads follow.'), 'Organic content. Paid ads follow.');
    assert.equal(rendered('Organic content;[1]! Paid ads follow.'), 'Organic content! Paid ads follow.');
  });

  it('leaves punctuation the author meant alone', () => {
    assert.equal(rendered('Wait... then check.'), 'Wait... then check.');
    assert.equal(rendered('Wait[1]... then check.'), 'Wait... then check.');
    assert.equal(rendered('Hmm,[1]... then check.'), 'Hmm... then check.');
    assert.equal(rendered('Really[1]?! Yes.'), 'Really?! Yes.');
    assert.equal(rendered('e.g. 3.5 stars; see qobo.dev. Also: plans!'), 'e.g. 3.5 stars; see qobo.dev. Also: plans!');
  });

  it('closes brackets up and drops a comma the marker left stranded', () => {
    assert.equal(rendered('Paid ads (SEM [2] [3]).'), 'Paid ads (SEM).');
    assert.equal(rendered('Plans (Starter, [1]) are cheap.'), 'Plans (Starter) are cheap.');
  });

  it('keeps the space between words when a marker sat between them', () => {
    assert.equal(rendered('It is free [1] and simple [2] too.'), 'It is free and simple too.');
    assert.equal(rendered('One [1] two [2] three'), 'One two three');
  });

  it('produces no doubled mark for any punctuation pair around a marker', () => {
    const marks = ['.', ',', ';', ':', '!', '?'];
    for (const before of marks) {
      for (const after of marks) {
        const output = rendered(`Clause${before}[1]${after} Next clause.`);
        assert.ok(!/([.,;:!?])\1/.test(output), `${before}[1]${after} → ${output}`);
        assert.ok(/^Clause[.,;:!?] Next clause\.$/.test(output), `${before}[1]${after} → ${output}`);
      }
    }
  });

  it('holds for a whole realistic answer', () => {
    const answer =
      'SEO improves organic visibility,[1], while SEM buys placement [2]. ' +
      'QOBO offers advanced SEO [1][3], and the Starter plan is ₹499 [2].[3] ' +
      'Confirm the terms with the team [1], [2].';
    const output = rendered(answer);
    assert.ok(!/\[\d+\]/.test(output), output);
    assert.ok(!/([.,;:!?])\1/.test(output), output);
    assert.ok(!/\s[.,;:!?]/.test(output), output);
    assert.ok(output.startsWith('SEO improves organic visibility, while SEM buys placement.'), output);
  });
});

import assert from 'node:assert';
import { stripText } from '../../../src/text/strip.ts';

// F8: the FTS words layer's correctness cases -- comments, footnotes, callouts, block ids,
// tables, wikilinks, markup, autolinks, and code, each asserted against stripText's output.

describe('stripText', () => {
  it('%%comment%% content is absent', () => {
    const text = stripText('Visible prose.\n\n%%a hidden aside%%\n\nMore prose.');
    assert.ok(!text.includes('hidden aside'), text);
    assert.ok(text.includes('Visible prose'));
    assert.ok(text.includes('More prose'));
  });

  it('footnote definition text is present; the ref markers are not', () => {
    const text = stripText('A claim[^1].\n\n[^1]: the footnote body');
    assert.ok(!text.includes('[^'), text);
    assert.ok(text.includes('footnote body'));
    assert.ok(text.includes('claim'));
  });

  it('a callout marker is absent; its body text is present', () => {
    const text = stripText('> [!warning] Title\n> body text');
    assert.ok(!text.includes('[!warning]'), text);
    assert.ok(text.includes('Title'));
    assert.ok(text.includes('body text'));
  });

  it('a trailing block-id is absent', () => {
    const text = stripText('A referenceable paragraph. ^my-block-id');
    assert.ok(!text.includes('^my-block-id'), text);
    assert.ok(text.includes('referenceable paragraph'));
  });

  it('table cell text is present, without pipes or the delimiter row', () => {
    const text = stripText('| Model | Params |\n|---|---|\n| granite | 30M |');
    assert.ok(!text.includes('|'), text);
    assert.ok(!text.includes('---'), text);
    assert.ok(text.includes('Model'));
    assert.ok(text.includes('granite'));
    assert.ok(text.includes('30M'));
  });

  it('a wikilink resolves to its alias', () => {
    const text = stripText('see [[pricing-model|the model]] for details');
    assert.ok(!text.includes('[['), text);
    assert.ok(!text.includes('pricing-model'), text);
    assert.ok(text.includes('the model'));
  });

  it('emphasis markers, a link URL, and an image path are absent', () => {
    const text = stripText('**bold** text, [see docs](http://example.com/docs), ![alt text](img/pic.png)');
    assert.ok(!text.includes('**'), text);
    assert.ok(!text.includes('http://example.com/docs'), text);
    assert.ok(!text.includes('img/pic.png'), text);
    assert.ok(text.includes('bold'));
    assert.ok(text.includes('see docs'));
    assert.ok(text.includes('alt text'));
  });

  it('a bare autolink URL is absent', () => {
    const text = stripText('Read more at http://example.com/docs for details.');
    assert.ok(!text.includes('http://example.com/docs'), text);
    assert.ok(text.includes('Read more at'));
    assert.ok(text.includes('for details'));
  });

  it('code content is present', () => {
    const text = stripText('Run `const apiKey = process.env.KEY;` first.');
    assert.ok(text.includes('const apiKey = process.env.KEY;'));
  });
});

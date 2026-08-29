import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { segmentField, segmentMatch } from '../../../src/text/segment.ts';
import { runCli as spawnCli } from '../../lib/cli.ts';
import { scratchDir } from '../../lib/scratch.ts';

function writeConfig(dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, ...extra, queries: {} }));
}

function makeTree(extra: Record<string, unknown> = {}): string {
  const dir = scratchDir('segment');
  writeConfig(dir, extra);
  writeFileSync(join(dir, 'zh.md'), '---\ntitle: 中文\n---\n数据库全文搜索很有用。\n');
  writeFileSync(join(dir, 'ja.md'), '---\ntitle: 日本語\n---\nデータベース全文検索は便利です。\n');
  writeFileSync(join(dir, 'th.md'), '---\ntitle: ไทย\n---\nการค้นหาข้อความแบบเต็ม\n');
  writeFileSync(join(dir, 'en.md'), '---\ntitle: english\n---\nRevenue grew steadily. Running numbers.\n');
  writeFileSync(join(dir, 'ko.md'), '---\ntitle: 한국어\n---\n데이터베이스 전문 검색은 유용합니다\n');
  return dir;
}

function runCli(dir: string, args: string[]) {
  return spawnCli([...args, '--config', join(dir, 'sense.config.json')]);
}

function paths(dir: string, args: string[]): string[] {
  const result = runCli(dir, [...args, '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as Array<{ path: string }>).map((r) => r.path).sort();
}

describe('segmentMatch', () => {
  // Covers qualifier retargeting (title:/summary:/text: -> _seg columns), unqualified runs
  // scoped to all three sidecars via FTS5's column-set filter (single grapheme and multi-grapheme
  // phrase alike, since a bare unqualified token leaks the same way a phrase does), quoted-phrase
  // passthrough (an author's own quoting is their escape hatch to FTS5's native syntax, left
  // alone even though it can carry the same raw-column leak if they hand-space a CJK phrase --
  // that is their choice to opt out, not this rewrite's to make for them), and operator
  // preservation (AND/OR/NOT/parens survive the rewrite around the segmented terms).
  const SEG = '{title_seg summary_seg text_seg}:';
  const cases: Array<[string, string]> = [
    ['数据库', `${SEG}"数 据 库"`],
    ['数', `${SEG}数`],
    ['title:数据库', 'title_seg:"数 据 库"'],
    ['title: 数据库', 'title_seg:"数 据 库"'],
    ['summary:全文 OR text:检索', 'summary_seg:"全 文" OR text_seg:"检 索"'],
    ['-title:数据库', '-title_seg:"数 据 库"'],
    ['(title:数据库) AND revenue', '(title_seg:"数 据 库") AND revenue'],
    ['title:revenue', 'title:revenue'],
    ['revenue OR earnings', 'revenue OR earnings'],
    ['"数据库 exact"', '"数据库 exact"'],
    ['"数 据"', '"数 据"'], // author's own hand-spaced quoted phrase: still byte-identical
    ['东京 NOT 京都', `${SEG}"东 京" NOT ${SEG}"京 都"`],
    ['东京 OR budget', `${SEG}"东 京" OR budget`],
    ['budget 东京', `budget ${SEG}"东 京"`],
    ['-title:东京 数据', `-title_seg:"东 京" ${SEG}"数 据"`],
    ['东京 数据', `${SEG}"东 京" ${SEG}"数 据"`], // two runs, implicit AND, both column-set scoped
  ];
  for (const [input, want] of cases) {
    it(`rewrites ${JSON.stringify(input)}`, () => {
      assert.equal(segmentMatch(input), want);
    });
  }
});

describe('segmentMatch: unqualified rewrites are valid, composable FTS5 syntax', () => {
  function buildDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE VIRTUAL TABLE content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = 'porter unicode61')`);
    const insert = db.prepare(`INSERT INTO content (rowid, title, summary, text, path, title_seg, summary_seg, text_seg) VALUES (?, ?, '', ?, ?, ?, '', ?)`);
    const rows: Array<[string, string]> = [
      ['东京', 'p1'], // pure CJK run
      ['budget report', 'p2'], // pure Latin
      ['数据 budget', 'p3'], // mixed CJK + Latin
    ];
    rows.forEach(([text, path], i) => insert.run(i + 1, '', text, path, '', segmentField(text)));
    return db;
  }

  // Each case's rewrite must parse under FTS5 MATCH without throwing -- the risk this class of
  // test exists for: a column-set group juxtaposed with a plain phrase via implicit AND, which is
  // valid, unlike a parenthesized OR group in the same spot, which FTS5 rejects.
  const queries = ['东京 OR budget', '-title:东京 数据', 'budget 东京', '东京 budget', '东京 数据'];
  for (const q of queries) {
    it(`MATCH accepts the rewrite of ${JSON.stringify(q)}`, () => {
      const db = buildDb();
      assert.doesNotThrow(() => db.prepare('SELECT rowid FROM content WHERE content MATCH ?').all(segmentMatch(q)));
    });
  }
});

describe('segmentField', () => {
  for (const [label, text] of [
    ['english', 'Revenue grew steadily in Q3.'],
    ['french, decomposed é (base + combining acute, never starts a run)', 'café au lait'],
    ['korean', '데이터베이스 전문 검색은 유용합니다'],
    ['numbers', 'Q3 2026 revenue was 1234.56'],
  ] as Array<[string, string]>) {
    it(`stays empty for text with no unspaced-script run: ${label}`, () => {
      assert.equal(segmentField(text), '');
    });
  }

  it('explodes a Chinese run into barrier-delimited graphemes', () => {
    assert.equal(segmentField('数据库全文搜索很有用'), 'ꟷ 数 据 库 全 文 搜 索 很 有 用 ꟷ');
  });

  it('explodes a Japanese run (kana + kanji, one script class) the same way', () => {
    assert.equal(segmentField('データベース全文検索は便利です'), 'ꟷ デ ー タ ベ ー ス 全 文 検 索 は 便 利 で す ꟷ');
  });

  it('explodes a Thai run and keeps a combining mark attached to its base character', () => {
    // ค้ (base + mai tho) is one grapheme, not two -- the tokenizer must not split it.
    assert.equal(segmentField('ค้นหา'), 'ꟷ ค้ น ห า ꟷ');
    assert.equal(segmentField('การค้นหาข้อความ'), 'ꟷ ก า ร ค้ น ห า ข้ อ ค ว า ม ꟷ');
  });

  it('barriers only the unspaced run in mixed English + Chinese text', () => {
    assert.equal(segmentField('The 数据库 handles both'), 'The ꟷ 数 据 库 ꟷ handles both');
  });
});

describe('substring parity: search behaves like grep over unspaced-script text', () => {
  // Exercises the parity harness's substring-truth property: search(term) must return exactly
  // the docs whose raw text contains term, for every substring up to length 3. Fixture docs:
  // an ICU-killer split (东京都政府, where ICU splits differently depending on what follows), a
  // doc with no ICU dictionary entries at all, and mixed kana+kanji.
  const docs: Record<string, string> = {
    'doc1.md': '东京都政府的办公室',
    'doc2.md': '乒乓球拍卖完了',
    'doc3.md': 'データベースの全文検索',
  };

  function makeParityTree(): string {
    const dir = scratchDir('parity');
    writeConfig(dir);
    for (const [name, body] of Object.entries(docs)) writeFileSync(join(dir, name), `---\ntitle: note\n---\n${body}\n`);
    return dir;
  }

  // Plain code-point slicing is grapheme-accurate here: none of the three docs contains a
  // combining mark (verified: Array.from length equals string length for all three).
  function substrings(text: string, maxLen: number): string[] {
    const out: string[] = [];
    for (let len = 1; len <= maxLen; len++) for (let i = 0; i + len <= text.length; i++) out.push(text.slice(i, i + len));
    return out;
  }

  it('every substring of length 1-3 finds exactly the docs whose text contains it', () => {
    const dir = makeParityTree();
    const terms = new Set<string>();
    for (const body of Object.values(docs)) for (const s of substrings(body, 3)) terms.add(s);

    for (const term of terms) {
      const expected = Object.entries(docs)
        .filter(([, body]) => body.includes(term))
        .map(([name]) => name)
        .sort();
      assert.deepEqual(paths(dir, ['search', term]), expected, `substring ${JSON.stringify(term)}`);
    }
    assert.ok(terms.size >= 40, `expected a meaningful number of substrings, got ${terms.size}`);
  });

  it('a reversed pair whose graphemes all exist still finds nothing, so ordering is load-bearing', () => {
    // True-substring parity alone cannot catch a degrade to unordered AND; these can.
    const dir = makeParityTree();
    for (const term of ['京东', '府政', '球乓', '完卖', 'スーベ']) {
      const hit = Object.values(docs).some((body) => body.includes(term));
      assert.equal(hit, false, `probe ${term} must not be a real substring`);
      assert.deepEqual(paths(dir, ['search', term]), [], `reversed pair ${term}`);
    }
  });
});

describe('ranking: mirrored bm25 weights put a title hit above a body hit', () => {
  function makeRankTree(): string {
    const dir = scratchDir('rank');
    writeConfig(dir);
    writeFileSync(join(dir, 'title-hit.md'), '---\ntitle: 数据库指南\n---\n说明文档。\n');
    writeFileSync(join(dir, 'body-hit.md'), '---\ntitle: 工具说明\n---\n这是关于数据库的详细文档。\n');
    return dir;
  }

  it('a bare query ranks the title match first', () => {
    const dir = makeRankTree();
    const rows = JSON.parse(runCli(dir, ['search', '数据库', '--format', 'json']).stdout) as Array<{ path: string }>;
    assert.equal(rows[0].path, 'title-hit.md');
  });

  it('a title: qualifier narrows to the title sidecar, finding only the title note', () => {
    const dir = makeRankTree();
    assert.deepEqual(paths(dir, ['search', 'title:数据库']), ['title-hit.md']);
  });
});

describe('gating: content.tokenize turns segmentation off, on both sides', () => {
  it('sidecars stay empty and search never phrase-rewrites, but trigram still matches', () => {
    const dir = makeTree({ content: { tokenize: 'trigram' } });
    const rows = JSON.parse(runCli(dir, ['sql', 'SELECT title_seg, summary_seg, text_seg FROM content', '--format', 'json']).stdout) as Array<{ title_seg: string; summary_seg: string; text_seg: string }>;
    assert.ok(rows.length > 0);
    for (const r of rows) assert.deepEqual(r, { title_seg: '', summary_seg: '', text_seg: '' });
    // 3 characters, so trigram (not the sidecar phrase machinery) is what finds it; ja.md uses
    // 検索, not 搜索, so this substring is zh.md-only.
    assert.deepEqual(paths(dir, ['search', '全文搜']), ['zh.md']);
  });
});

describe('search across languages', () => {
  it('finds a two-character word, which the default tokenizer alone cannot', () => {
    const dir = makeTree();
    assert.deepEqual(paths(dir, ['search', '全文']), ['ja.md', 'zh.md']);
  });

  it('finds words in Thai, whose combining marks the default tokenizer fragments', () => {
    const dir = makeTree();
    assert.deepEqual(paths(dir, ['search', 'ค้นหา']), ['th.md']);
  });

  it('finds a multi-grapheme run through the phrase it becomes', () => {
    const dir = makeTree();
    assert.deepEqual(paths(dir, ['search', '数据库']), ['zh.md']);
  });

  it('leaves the languages that never needed it exactly as they were', () => {
    const dir = makeTree();
    assert.deepEqual(paths(dir, ['search', 'run']), ['en.md']); // still stems
    assert.deepEqual(paths(dir, ['search', '전문']), ['ko.md']); // Korean has its own spaces
  });

  it('costs nothing on a tree that carries no such text', () => {
    const dir = makeTree();
    runCli(dir, ['sql', 'SELECT 1']);
    const rows = JSON.parse(runCli(dir, ['sql', "SELECT path FROM content WHERE title_seg <> '' OR summary_seg <> '' OR text_seg <> '' ORDER BY path", '--format', 'json']).stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['ja.md', 'th.md', 'zh.md']
    );
  });
});

describe('segment() in hand-written SQL', () => {
  it('is what a raw MATCH needs, since the statement cannot be rewritten for the author', () => {
    const dir = makeTree();
    assert.deepEqual(paths(dir, ['sql', "SELECT path FROM content WHERE content MATCH '数据库'"]), []);
    assert.deepEqual(paths(dir, ['sql', 'SELECT path FROM content WHERE content MATCH segment(?)', '数据库']), ['zh.md']);
  });
});

describe('compatibility with the columns the docs name', () => {
  it('bm25 and snippet still address the first three columns after the sidecars were appended', () => {
    const dir = makeTree();
    const ranked = runCli(dir, ['sql', "SELECT path, bm25(content, 10.0, 5.0, 1.0) AS s FROM content WHERE content MATCH 'revenue' ORDER BY s", '--format', 'json']);
    assert.equal(ranked.status, 0, ranked.stderr);
    assert.match(ranked.stdout, /en\.md/);
    const snip = runCli(dir, ['sql', "SELECT snippet(content, 2, '[', ']', '..', 5) AS x FROM content WHERE content MATCH 'revenue'", '--format', 'json']);
    assert.match(snip.stdout, /\[Revenue\]/);
  });
});

// A small alphabet exercising every construct segment.ts's contract has to handle: two Han base
// characters (so a run can be more than one grapheme), one hiragana, one Thai base+combining-mark
// cluster (one grapheme, two code points), CJK punctuation whose Script_Extensions keep it inside
// a run, a space, and one Latin letter.
const HAN1 = '数';
const HAN2 = '据';
const HIRAGANA = 'あ';
const THAI = 'ค้'; // consonant + MAI THO: one grapheme cluster
const PUNCTUATION = '。';
const SPACE = ' ';
const LATIN = 'a';
const ALPHABET = [HAN1, HAN2, HIRAGANA, THAI, PUNCTUATION, SPACE, LATIN];

// Every string this alphabet forms, length 1 through MAX_LEN: 19,607 strings at 5, enumerated
// and indexed in ~0.3s and queried in ~1s (measured) -- comfortably under the ~10s budget.
const MAX_LEN = 5;

function enumerate(alphabet: string[], maxLen: number): string[] {
  const out: string[] = [];
  let level = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const prefix of level) for (const sym of alphabet) next.push(prefix + sym);
    out.push(...next);
    level = next;
  }
  return out;
}

const DOCS = enumerate(ALPHABET, MAX_LEN);
// The pure unspaced-script subset: grapheme-aligned and punctuation-free, so substring semantics
// is the whole claim (a query holding a space or 。 is expected to split into separate phrases;
// one holding the Latin letter never enters a run at all).
const PURE_UNSPACED = /^(?:数|据|あ|ค้)+$/;
const QUERIES = DOCS.filter((d) => PURE_UNSPACED.test(d));

function buildContractDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Production DDL shape (src/db/open.ts ensureSchema), standalone: the claim under test is
  // segmentField/segmentMatch against real FTS5, not the reconcile/scan pipeline around them.
  db.exec(`CREATE VIRTUAL TABLE content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = 'porter unicode61')`);
  const insert = db.prepare(`INSERT INTO content (rowid, title, summary, text, path, title_seg, summary_seg, text_seg) VALUES (?, '', '', ?, ?, '', '', ?)`);
  DOCS.forEach((d, i) => insert.run(i + 1, d, `p${i}`, segmentField(d)));
  return db;
}

describe('segment contract: exhaustive small-scope enumeration against String.prototype.includes', () => {
  const db = buildContractDb();
  // What search() actually runs (src/commands/search.ts matchSql): MATCH with the rewritten
  // query, which an unqualified run now scopes to the sidecars itself (SIDECAR_COLUMNS).
  const matchAll = db.prepare('SELECT rowid FROM content WHERE content MATCH ?');

  it(`checks ${QUERIES.length} pure unspaced-script substrings against ${DOCS.length} documents`, () => {
    let falseNegatives = 0;
    let falsePositives = 0;
    const negExamples: string[] = [];
    const posExamples: string[] = [];

    for (const q of QUERIES) {
      const rewritten = segmentMatch(q);
      const expected = new Set(DOCS.filter((d) => d.includes(q)));
      const gotDocs = new Set((matchAll.all(rewritten) as Array<{ rowid: number }>).map((r) => DOCS[r.rowid - 1]));

      for (const d of expected) {
        if (!gotDocs.has(d)) {
          falseNegatives++;
          if (negExamples.length < 5) negExamples.push(`${JSON.stringify(q)} missed ${JSON.stringify(d)}`);
        }
      }

      for (const d of gotDocs) {
        if (expected.has(d)) continue;
        falsePositives++;
        if (posExamples.length < 5) posExamples.push(`${JSON.stringify(q)} -> ${JSON.stringify(d)}`);
      }
    }

    assert.equal(falseNegatives, 0, `false negatives (recall must be exact):\n${negExamples.join('\n')}`);
    // An unqualified run now targets only the segmented sidecars (src/segment.ts SIDECAR_COLUMNS),
    // so raw title/summary/text -- where unicode61 drops punctuation and reads it the same as a
    // real gap -- are never checked by the rewritten query at all; zero false positives anywhere.
    assert.equal(falsePositives, 0, `false positives:\n${posExamples.join('\n')}`);
  });
});

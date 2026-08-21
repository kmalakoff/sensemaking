import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../lib/cli.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// The llm-wiki example config from skills/sense-setup/EXAMPLES.md, run verbatim through the
// CLI. Its `embed` block points at a local fixture model, so the semantic path never hits the
// network.
function writeModel(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-model-'));
  const vocab = { '[UNK]': 0, attention: 1, scales: 2, problems: 3 };
  writeFileSync(
    join(dir, 'tokenizer.json'),
    JSON.stringify({
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: { type: 'Lowercase' },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      post_processor: null,
      decoder: null,
      model: { type: 'WordLevel', vocab, unk_token: '[UNK]' },
    })
  );
  const rows = [
    [0, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ];
  const data = new Float32Array(rows.flat());
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: 'F32', shape: [4, 4], data_offsets: [0, data.byteLength] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  writeFileSync(join(dir, 'model.safetensors'), Buffer.concat([len, header, Buffer.from(data.buffer)]));
  return dir;
}

const LLM_WIKI_CONFIG = {
  version: 4,
  presets: {
    default: { include: ['wiki/**/*.md'], k: 10 },
    raw: { include: ['raw/**/*.md'], k: 5 },
  },
  queries: {
    uncompiled: { sql: "SELECT path FROM frontmatter WHERE path LIKE 'raw/%' AND path NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)" },
    'dead-links': { sql: 'SELECT src, target FROM links WHERE dst IS NULL' },
    explore: { search: 'open problems', preset: 'default', k: 20 },
    'source-check': { search: 'benchmark methodology', preset: 'raw' },
  },
};

function llmWikiTree(): string {
  const dir = tmpTree();
  writeNote(dir, 'wiki/attention.md', {
    frontmatter: { title: 'Attention Mechanisms' },
    body: 'Open problems remain in how attention scales. See [[paper1]] for the benchmark methodology, and [[missing-source]] for further context.',
  });
  writeNote(dir, 'wiki/rotary.md', { frontmatter: { title: 'Rotary Embeddings' }, body: 'Rotary embeddings adjust positional encoding.' });
  writeNote(dir, 'raw/paper1.md', { frontmatter: { title: 'Paper One' }, body: 'This paper describes the benchmark methodology in detail.' });
  writeNote(dir, 'raw/paper2.md', { frontmatter: { title: 'Paper Two' }, body: 'This paper is not yet cited by the wiki.' });
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ ...LLM_WIKI_CONFIG, embed: { model: writeModel(), type: 'static' } }));
  return dir;
}

describe('llm-wiki example config (skills/sense-setup/EXAMPLES.md)', () => {
  it('sense uncompiled: raw sources nothing in the wiki cites yet', () => {
    const dir = llmWikiTree();
    const result = runCli(['uncompiled', '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['raw/paper2.md']
    );
  });

  it('sense dead-links: a citation with no resolvable target', () => {
    const dir = llmWikiTree();
    const result = runCli(['dead-links', '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ src: string; target: string }>;
    assert.deepEqual(rows, [{ src: 'wiki/attention.md', target: 'missing-source' }]);
  });

  it('sense search "..." (default preset, wiki only): finds the matching wiki page, not raw sources', async () => {
    const dir = llmWikiTree();
    const result = runCli(['search', 'attention scales', '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.ok(rows.some((r) => r.path === 'wiki/attention.md'));
    assert.ok(
      rows.every((r) => r.path.startsWith('wiki/')),
      `default preset should never surface raw/: ${JSON.stringify(rows)}`
    );
  });

  it('sense search "..." --preset raw: cites from the sources, never from the wiki pages', () => {
    const dir = llmWikiTree();
    const result = runCli(['search', 'benchmark methodology', '--preset', 'raw', '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string; via: string }>;
    assert.ok(rows.some((r) => r.path === 'raw/paper1.md'));
    assert.ok(
      rows.every((r) => r.path.startsWith('raw/')),
      `raw preset scopes to raw/: ${JSON.stringify(rows)}`
    );
  });

  it('sense explore: the saved default-preset search, by name, with its own k', () => {
    const dir = llmWikiTree();
    const result = runCli(['explore', '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.ok(rows.some((r) => r.path === 'wiki/attention.md'));
  });

  it('sense source-check: the saved raw-preset search, by name', () => {
    const dir = llmWikiTree();
    const result = runCli(['source-check', '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string }>;
    assert.ok(rows.some((r) => r.path === 'raw/paper1.md'));
  });

  it('sense check: every saved query/search in the example config probes clean', () => {
    const dir = llmWikiTree();
    const result = runCli(['check'], { cwd: dir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /FAILED/);
  });

  it('sense status and sense map report per-preset coverage for both wiki and raw', () => {
    const dir = llmWikiTree();
    const status = runCli(['status', '--format', 'json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr);
    const statusPresets = JSON.parse(status.stdout).presets as Array<{ name: string; files: number; embedded: number }>;
    const byName = new Map(statusPresets.map((p) => [p.name, p]));
    assert.equal(byName.get('default')?.files, 2, 'default (wiki/**) covers the two wiki pages');
    assert.equal(byName.get('raw')?.files, 2, 'raw covers the two raw sources');
    // Vectors are lazy: rows start NULL and fill on the first search, so a fresh status
    // reports 0 embedded for both presets, not "vectors off".
    assert.equal(byName.get('raw')?.embedded, 0, 'nothing embedded yet on a fresh index');

    const map = runCli(['map', '--format', 'json'], { cwd: dir });
    assert.equal(map.status, 0, map.stderr);
    const mapPresets = JSON.parse(map.stdout).presets as Array<{ name: string; files: number }>;
    assert.equal(mapPresets.length, 2);
  });
});

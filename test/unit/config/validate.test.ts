import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { featureSignature, SUPPORTED_CONFIG_VERSION } from '../../../src/config/index.ts';
import { FEATURES } from '../../../src/features/index.ts';
import { packageRoot, runCli } from '../../lib/cli.ts';

function runWith(config: string, args: string[] = ['--list']) {
  const dir = mkdtempSync(join(tmpdir(), 'sense-validate-'));
  writeFileSync(join(dir, 'sense.config.json'), config);
  return runCli([...args, '--config', join(dir, 'sense.config.json')]);
}

describe('config validation', () => {
  it('missing queries defaults to none, not a crash', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}}}');
    assert.equal(result.status, 0, result.stderr);
  });

  it('missing presets is a named error, not a TypeError', () => {
    const result = runWith('{"version":4,"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets must be a non-empty object/);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });

  it('empty presets object is rejected', () => {
    const result = runWith('{"version":4,"presets":{},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets must be a non-empty object/);
  });

  it('a "default" preset is required', () => {
    const result = runWith('{"version":4,"presets":{"wiki":{"include":["*.md"]}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets must include a "default" preset/);
  });

  it('empty include array within a preset is rejected', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":[]}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.include must be a non-empty array/);
  });

  it('every preset requires include, including "default" -- no exception for it', () => {
    const result = runWith('{"version":4,"presets":{"default":{}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.include must be a non-empty array/);
  });

  it('non-object config is rejected', () => {
    const result = runWith('["not","a","config"]');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a JSON object/);
  });

  it('a typo subcommand on a saved-less config exits 2 with the unknown-entry message', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}}}', ['mapp']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command or saved entry: "mapp"/);
  });

  it('non-boolean feature value is rejected', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"features":{"links":"yes"}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\.links must be a boolean/);
  });

  it('embed is not a features key', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"features":{"embed":true}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features has unknown key\(s\) embed/);
  });

  it('the top-level embed block accepts provider settings alongside the model', () => {
    assert.equal(runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"embed":{"model":"some/model"}}').status, 0);
    assert.equal(runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"embed":{"model":"some/model","type":"api","url":"http://x/v1"}}').status, 0);
  });

  it('no embed block is valid and simply means no vectors', () => {
    assert.equal(runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"queries":{}}').status, 0);
  });

  it('embed with an unknown provider is rejected', () => {
    const result = runWith('{"version":5,"presets":{"default":{"include":["*.md"]}},"embed":{"model":"some/model","provider":"weird"}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /embed\.provider must be "static", "openai", or "cohere"/);
  });

  it('a v4 config still carrying "semantic" migrates it to signals; a non-boolean value is a named migration error', () => {
    assert.equal(runWith('{"version":4,"presets":{"default":{"include":["*.md"],"semantic":false}},"queries":{}}').status, 0);
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"],"semantic":{"type":"api"}}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.semantic must be a boolean/);
  });

  it('signals must be a non-empty object naming valid signals', () => {
    const empty = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{}}},"queries":{}}');
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /presets\.default\.signals must be a non-empty object/);

    const unknown = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"words":1,"typos":1}}},"queries":{}}');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /presets\.default\.signals names unknown signal\(s\) typos/);
    assert.match(unknown.stderr, /valid signals are words, links, vectors/);
  });

  it('a signal weight must be a finite number > 0', () => {
    const zero = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"words":0}}},"queries":{}}');
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /presets\.default\.signals\.words must be a finite number > 0/);

    const negative = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"words":-1}}},"queries":{}}');
    assert.equal(negative.status, 1);
    assert.match(negative.stderr, /presets\.default\.signals\.words must be a finite number > 0/);

    const nonNumber = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"words":"1"}}},"queries":{}}');
    assert.equal(nonNumber.status, 1);
    assert.match(nonNumber.stderr, /presets\.default\.signals\.words must be a finite number > 0/);
  });

  it('signals: {"links":1} without "words" is rejected, naming both keys', () => {
    const result = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"links":1}}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.signals has "links" without "words"/);
  });

  it('signals: {"vectors":1} with no embed block is rejected, naming both keys', () => {
    const result = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"vectors":1}}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.signals includes "vectors", but no "embed" block names a model/);
  });

  it('signals: {"vectors":1} with an embed block present is accepted, even without "words"', () => {
    const result = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"vectors":1}}},"embed":{"model":"some/model"},"queries":{}}');
    assert.equal(result.status, 0, result.stderr);
  });

  it('signals: {"vectors":4} is accepted, weighting the vectors signal above default', () => {
    const result = runWith('{"version":5,"presets":{"default":{"include":["*.md"],"signals":{"words":1,"vectors":4}}},"embed":{"model":"some/model"},"queries":{}}');
    assert.equal(result.status, 0, result.stderr);
  });

  it('embed.model is required when the block is present -- provider settings without a model embed nothing', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"embed":{"type":"api","url":"http://x/v1"},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /embed\.model is required/);
  });

  it('a newer config version fails the version gate, not shape validation', () => {
    const newer = SUPPORTED_CONFIG_VERSION + 1;
    const result = runWith(`{"version":${newer},"embed":{"provider":"x"}}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`config version ${newer} requires a newer sense`));
  });

  it('an unrecognised top-level key is reported, not silently ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-unknown-'));
    const configPath = join(dir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, queries: {}, bogus: true }));
    const result = runCli(['--list', '--config', configPath]);
    assert.equal(result.status, 0, 'still runs');
    assert.match(result.stderr, /bogus/);
    assert.match(result.stderr, /does not read/);
  });

  it('an unrecognised key inside a preset is a hard error, not a warning', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"],"bogus":true}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default has unknown key\(s\) bogus/);
  });

  it('checks is rejected with a named error, not silently ignored as an unknown key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-checks-'));
    const configPath = join(dir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, queries: {}, checks: { nope: 'empty' } }));
    const result = runCli(['--list', '--config', configPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checks was removed in v3/);
  });

  it('a saved search requires non-empty search text -- a scope without a question is just flags', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"queries":{"empty":{"search":"","k":5}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.empty\.search must be non-empty text/);
  });

  it('a saved search with an unknown key is rejected', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"search":"pricing","semanticc":true}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.q has unknown key\(s\) semanticc/);
  });

  it('a { sql } saved query requires a non-empty string', () => {
    const result = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"sql":""}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.q\.sql must be a non-empty string/);
  });

  it('a saved search preset must be a string, and include a non-empty glob array', () => {
    const badPreset = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"search":"pricing","preset":5}}}');
    assert.equal(badPreset.status, 1);
    assert.match(badPreset.stderr, /queries\.q\.preset must be a preset name/);

    const badInclude = runWith('{"version":4,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"search":"pricing","include":[]}}}');
    assert.equal(badInclude.status, 1);
    assert.match(badInclude.stderr, /queries\.q\.include must be a non-empty array/);
  });

  it('--help lists every command in the registry', async () => {
    // Guards the gap that shipped in 0.7.x: `check` existed and worked but was absent from
    // --help, so the command that answers "is my config broken" was undiscoverable from the
    // CLI itself.
    const { COMMANDS } = (await import(pathToFileURL(join(packageRoot, 'dist', 'esm', 'cli', 'index.js')).href)) as { COMMANDS: Record<string, unknown> };
    const help = runCli(['--help']).stdout + runCli([]).stderr;
    for (const name of Object.keys(COMMANDS)) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(help), `${name} is a command but is missing from --help`);
    }
  });
});

describe('featureSignature', () => {
  it('changes when the embed block appears or disappears, since that is the whole vector switch', () => {
    // featureSignature isn't part of the public barrel (internals stay module-private);
    // reach it the same way test/integration/verbs.test.ts reaches other src-internal helpers.
    // FEATURES (not activeFeatures(cfg)) matches production: embed's segment is driven by
    // embedConfig(cfg) inside the feature itself, independent of any "active" filtering.
    const base = { presets: { default: { include: ['*.md'] }, raw: { include: ['raw/**/*.md'] } }, queries: {} };
    const vectorsOff = featureSignature(base, FEATURES);
    const vectorsOn = featureSignature({ ...base, embed: { model: 'minishlab/potion-retrieval-32M', provider: 'static' as const } }, FEATURES);
    assert.notEqual(vectorsOff, vectorsOn);
  });

  it("changes when a preset's include/exclude changes, so an edit that only reshapes coverage still rebuilds", () => {
    const base = { presets: { default: { include: ['*.md'] } }, queries: {} };
    const widened = featureSignature({ presets: { default: { include: ['**/*.md'] } }, queries: {} }, FEATURES);
    assert.notEqual(featureSignature(base, FEATURES), widened);
  });
});

describe('embed block: openai url and declared languages', () => {
  const withEmbed = (embed: string) => runWith(`{"version":5,"presets":{"default":{"include":["*.md"]}},"queries":{},"embed":${embed}}`);

  it('openai without url is a config error naming the key', () => {
    const result = withEmbed('{"model":"bge-m3","provider":"openai"}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /embed\.provider "openai" requires embed\.url/);
  });

  it('languages must be a non-empty array of tags', () => {
    for (const bad of ['[]', '["en",3]']) {
      const result = withEmbed(`{"model":"m","provider":"cohere","languages":${bad}}`);
      assert.equal(result.status, 1, bad);
      assert.match(result.stderr, /embed\.languages/);
    }
    const ok = withEmbed('{"model":"m","provider":"cohere","languages":["en","zh"]}');
    assert.equal(ok.status, 0, ok.stderr);
  });

  it('chunkTokens must be a positive integer', () => {
    for (const bad of ['0', '-1', '1.5', '"100"']) {
      const result = withEmbed(`{"model":"m","chunkTokens":${bad}}`);
      assert.equal(result.status, 1, bad);
      assert.match(result.stderr, /embed\.chunkTokens must be a positive integer/);
    }
    assert.equal(withEmbed('{"model":"m"}').status, 0, 'absent is valid');
    const ok = withEmbed('{"model":"m","chunkTokens":100}');
    assert.equal(ok.status, 0, ok.stderr);
  });
});

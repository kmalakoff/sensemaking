import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { featureSignature } from '../../src/config.ts';
import { packageRoot, runCli } from '../lib/cli.ts';

function runWith(config: string, args: string[] = ['--list']) {
  const dir = mkdtempSync(join(tmpdir(), 'sense-validate-'));
  writeFileSync(join(dir, 'sense.config.json'), config);
  return runCli([...args, '--config', join(dir, 'sense.config.json')]);
}

describe('config validation', () => {
  it('missing queries defaults to none, not a crash', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}}}');
    assert.equal(result.status, 0, result.stderr);
  });

  it('missing presets is a named error, not a TypeError', () => {
    const result = runWith('{"version":3,"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets must be a non-empty object/);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });

  it('empty presets object is rejected', () => {
    const result = runWith('{"version":3,"presets":{},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets must be a non-empty object/);
  });

  it('a "default" preset is required', () => {
    const result = runWith('{"version":3,"presets":{"wiki":{"include":["*.md"]}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets must include a "default" preset/);
  });

  it('empty include array within a preset is rejected', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":[]}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.include must be a non-empty array/);
  });

  it('every preset requires include, including "default" -- no exception for it', () => {
    const result = runWith('{"version":3,"presets":{"default":{}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.include must be a non-empty array/);
  });

  it('non-object config is rejected', () => {
    const result = runWith('["not","a","config"]');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a JSON object/);
  });

  it('a typo subcommand on a queries-less config exits 2 with the unknown-query message', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}}}', ['mapp']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown query: "mapp"/);
  });

  it('non-boolean feature value is rejected', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"features":{"links":"yes"}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\.links must be a boolean/);
  });

  it('embed is not a features key', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"features":{"embed":true}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features has unknown key\(s\) embed/);
  });

  it('the top-level embed block accepts provider settings', () => {
    assert.equal(runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"embed":{}}').status, 0);
    assert.equal(runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"embed":{"type":"api","url":"http://x/v1"}}').status, 0);
  });

  it('embed with an unknown type is rejected', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"embed":{"type":"weird"}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /embed\.type must be "static" or "api"/);
  });

  it('a preset only accepts a boolean for semantic, not the embed object form', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"],"semantic":{"type":"api"}}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default\.semantic must be a boolean/);
  });

  it('a newer config version fails the version gate, not shape validation', () => {
    const result = runWith(`{"version":${4},"embed":{"provider":"x"}}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config version 4 requires a newer sense/);
  });

  it('an unrecognised top-level key is reported, not silently ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-unknown-'));
    const configPath = join(dir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 3, presets: { default: { include: ['*.md'] } }, queries: {}, bogus: true }));
    const result = runCli(['--list', '--config', configPath]);
    assert.equal(result.status, 0, 'still runs');
    assert.match(result.stderr, /bogus/);
    assert.match(result.stderr, /does not read/);
  });

  it('an unrecognised key inside a preset is a hard error, not a warning', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"],"bogus":true}},"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /presets\.default has unknown key\(s\) bogus/);
  });

  it('checks is rejected with a named error, not silently ignored as an unknown key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-checks-'));
    const configPath = join(dir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 3, presets: { default: { include: ['*.md'] } }, queries: {}, checks: { nope: 'empty' } }));
    const result = runCli(['--list', '--config', configPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checks was removed in v3/);
  });

  it('a saved search requires non-empty search text -- a scope without a question is just flags', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"queries":{"empty":{"search":"","k":5}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.empty\.search must be non-empty text/);
  });

  it('a saved search with an unknown key is rejected', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"search":"pricing","semanticc":true}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.q has unknown key\(s\) semanticc/);
  });

  it('a { sql } saved query requires a non-empty string', () => {
    const result = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"sql":""}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.q\.sql must be a non-empty string/);
  });

  it('a saved search preset must be a string, and include a non-empty glob array', () => {
    const badPreset = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"search":"pricing","preset":5}}}');
    assert.equal(badPreset.status, 1);
    assert.match(badPreset.stderr, /queries\.q\.preset must be a preset name/);

    const badInclude = runWith('{"version":3,"presets":{"default":{"include":["*.md"]}},"queries":{"q":{"search":"pricing","include":[]}}}');
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
  it("changes when a preset's semantic flips, even though features/embed are unchanged", () => {
    // featureSignature isn't part of the public barrel (internals stay module-private);
    // reach it the same way test/unit/verbs.test.ts reaches other src-internal helpers.
    const base = { presets: { default: { include: ['*.md'] }, raw: { include: ['raw/**/*.md'] } }, queries: {} };
    const semanticOn = featureSignature(base);
    const semanticOff = featureSignature({ ...base, presets: { ...base.presets, raw: { include: ['raw/**/*.md'], semantic: false } } });
    assert.notEqual(semanticOn, semanticOff);
  });

  it("changes when a preset's include/exclude changes, so an edit that only reshapes coverage still rebuilds", () => {
    const base = { presets: { default: { include: ['*.md'] } }, queries: {} };
    const widened = featureSignature({ presets: { default: { include: ['**/*.md'] } }, queries: {} });
    assert.notEqual(featureSignature(base), widened);
  });
});

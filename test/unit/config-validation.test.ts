import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli } from '../lib/cli.ts';

function runWith(config: string, args: string[] = ['--list']) {
  const dir = mkdtempSync(join(tmpdir(), 'sense-validate-'));
  writeFileSync(join(dir, 'sense.config.json'), config);
  return runCli([...args, '--config', join(dir, 'sense.config.json')]);
}

describe('config validation', () => {
  it('missing queries defaults to none, not a crash', () => {
    const result = runWith('{"version":2,"scan":{"include":["*.md"]}}');
    assert.equal(result.status, 0, result.stderr);
  });

  it('missing scan.include is a named error, not a TypeError', () => {
    const result = runWith('{"version":2,"queries":{}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scan\.include must be a non-empty array/);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });

  it('empty include array is rejected', () => {
    const result = runWith('{"version":2,"scan":{"include":[]}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scan\.include/);
  });

  it('non-object config is rejected', () => {
    const result = runWith('["not","a","config"]');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a JSON object/);
  });

  it('a typo subcommand on a queries-less config exits 2 with the unknown-query message', () => {
    const result = runWith('{"version":2,"scan":{"include":["*.md"]}}', ['mapp']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown query: "mapp"/);
  });

  it('non-boolean feature value is rejected', () => {
    const result = runWith('{"version":2,"scan":{"include":["*.md"]},"features":{"links":"yes"}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\.links must be a boolean/);
  });

  it('embed accepts true and the object form', () => {
    assert.equal(runWith('{"version":2,"scan":{"include":["*.md"]},"features":{"embed":true}}').status, 0);
    assert.equal(runWith('{"version":2,"scan":{"include":["*.md"]},"features":{"embed":{"type":"api","url":"http://x/v1"}}}').status, 0);
  });

  it('embed with an unknown type is rejected', () => {
    const result = runWith('{"version":2,"scan":{"include":["*.md"]},"features":{"embed":{"type":"weird"}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\.embed must be a boolean or \{/);
  });

  it('a newer config version fails the version gate, not shape validation', () => {
    const result = runWith('{"version":3,"features":{"embed":{"provider":"x"}}}');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config version 3 requires a newer sense/);
  });

  it('an unrecognised key is reported, not silently ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sense-unknown-'));
    const configPath = join(dir, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 2, scan: { include: ['*.md'], exclude: ['x/**'] }, queries: {} }));
    const result = runCli(['--list', '--config', configPath]);
    assert.equal(result.status, 0, 'still runs');
    assert.match(result.stderr, /scan\.exclude/);
    assert.match(result.stderr, /does not read/);
  });
});

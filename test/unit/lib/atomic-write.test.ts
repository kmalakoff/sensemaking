import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { writeFileAtomic } from '../../../src/lib/atomic-write.ts';
import { scratchDir } from '../../lib/scratch.ts';

describe('writeFileAtomic', () => {
  it('writes the file and preserves an unrelated staging sibling', () => {
    const dir = scratchDir('atomic-write');
    const target = join(dir, 'file.json');
    writeFileSync(`${target}.part`, 'another writer');
    writeFileAtomic(target, 'hello');
    assert.equal(readFileSync(target, 'utf8'), 'hello');
    assert.equal(readFileSync(`${target}.part`, 'utf8'), 'another writer');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.part')),
      ['file.json.part']
    );
  });

  it('overwrites an existing file', () => {
    const target = join(scratchDir('atomic-write'), 'file.json');
    writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
  });

  it('accepts a Buffer', () => {
    const target = join(scratchDir('atomic-write'), 'file.bin');
    writeFileAtomic(target, Buffer.from([1, 2, 3]));
    assert.deepEqual(readFileSync(target), Buffer.from([1, 2, 3]));
  });

  it('leaves another writer staging file intact and cleans up its own staging file when rename fails', () => {
    const dir = scratchDir('atomic-write');
    const target = join(dir, 'target');
    const otherWriter = `${target}.other.part`;
    writeFileSync(otherWriter, 'other writer');
    mkdirSync(target); // a file can't be renamed onto an existing directory
    assert.throws(() => writeFileAtomic(target, 'data'));
    assert.equal(readFileSync(otherWriter, 'utf8'), 'other writer');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.part')),
      ['target.other.part']
    );
    assert.ok(existsSync(target));
  });
});

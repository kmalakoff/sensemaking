import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { writeFileAtomic } from '../../../src/lib/atomic-write.ts';
import { scratchDir } from '../../lib/scratch.ts';

describe('writeFileAtomic', () => {
  it('writes the file and leaves no .part sibling', () => {
    const target = join(scratchDir('atomic-write'), 'file.json');
    writeFileAtomic(target, 'hello');
    assert.equal(readFileSync(target, 'utf8'), 'hello');
    assert.ok(!existsSync(`${target}.part`));
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

  it('cleans up the .part file when the rename fails', () => {
    const target = join(scratchDir('atomic-write'), 'target');
    mkdirSync(target); // a file can't be renamed onto an existing directory
    assert.throws(() => writeFileAtomic(target, 'data'));
    assert.ok(!existsSync(`${target}.part`), 'a failed rename should not leave the temp file behind');
  });
});

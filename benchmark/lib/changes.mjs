import { spawnSync } from 'node:child_process';

function git(root, argv, maxBuffer = 16e6) {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer });
  if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const nulPaths = (stdout) => stdout.split('\0').filter(Boolean);

// --no-renames exposes both the deleted and added sides of a rename. Untracked files are a
// separate Git set and must join the diff because they can ship with the working tree.
export function releaseChanges(root) {
  const lastTag = git(root, ['describe', '--tags', '--abbrev=0']).trim();
  const tracked = nulPaths(git(root, ['diff', '--name-only', '--no-renames', '-z', lastTag]));
  const untracked = nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return { lastTag, paths: [...new Set([...tracked, ...untracked])].sort(), untracked: [...new Set(untracked)].sort() };
}

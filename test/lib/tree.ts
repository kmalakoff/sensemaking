import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, Preset } from 'sensemaking';
import { open } from 'sensemaking';
import { scratchDir } from './scratch.ts';

// Throwaway markdown trees for unit tests.

export { scratchDir } from './scratch.ts';

export function tmpTree(): string {
  return scratchDir('test');
}

export interface NoteSpec {
  // An object is JSON-serialized per key (the convenient form for well-formed frontmatter); a
  // string is written verbatim, the only way to express the malformed YAML the parse-policy tests are about.
  frontmatter?: Record<string, unknown> | string;
  body?: string;
}

export function writeNote(baseDir: string, relPath: string, { frontmatter = {}, body = 'body' }: NoteSpec = {}): void {
  const fm =
    typeof frontmatter === 'string'
      ? frontmatter
      : Object.entries(frontmatter)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n');
  mkdirSync(dirname(join(baseDir, relPath)), { recursive: true });
  writeFileSync(join(baseDir, relPath), `---\n${fm}\n---\n\n${body}\n`);
}

// 12 short, distinct Mandarin sentences: comfortably past the language-fit check's
// classified-chunk floor, and one language throughout, for an unambiguous majority.
export const CHINESE_SENTENCES = [
  '今天天气非常好,适合出去散步。',
  '这个软件可以帮助你管理你的时间。',
  '请把这份文件交给经理签字。',
  '中国有着悠久的历史和灿烂的文化。',
  '我们计划下个月去北京旅游。',
  '这本书讲述了一个动人的故事。',
  '他每天早上都会去公园锻炼身体。',
  '这家餐厅的菜味道非常地道。',
  '学习一门新语言需要坚持和耐心。',
  '这个城市的交通非常拥堵。',
  '她喜欢在周末读书和画画。',
  '科技的发展改变了我们的生活方式。',
];

// A tree whose classified majority is Mandarin, for the language-fit check on both sides.
export function chineseTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'zh.md', { body: CHINESE_SENTENCES.map((line, i) => `## S${i}\n\n${line}`).join('\n\n') });
  return baseDir;
}

// The `embed` block is the whole vector switch, so a tree without one has no vectors and never
// reaches the model: that is what a bare call gives you. Tests that want vectors pass an `embed` block pointing at a local fixture model.
export function openTree(baseDir: string, features?: Config['features'], presets?: Record<string, Preset>) {
  return open({ presets: presets ?? { default: { include: ['**/*.md'] } }, queries: {}, features, baseDir, configPath: null });
}

// For tests that need config beyond features/presets (embed provider settings, queries).
export function openConfig(cfg: Parameters<typeof open>[0]) {
  return open(cfg);
}

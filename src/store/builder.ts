import { channel } from 'node:diagnostics_channel';
import { type Config, featureEnabled, featureSignature, type ResolvedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { embed } from '../features/embed.ts';
import { FEATURES } from '../features/index.ts';
import { rank } from '../features/rank.ts';
import type { ReconcileDelta } from '../features/types.ts';
import { listFiles } from '../scan/index.ts';
import { ParsePool } from '../scan/pool.ts';
import { reparseFiles } from '../scan/reparse.ts';
import { classifyEmbedChange } from './embed-scope.ts';
import { classifyFeatureToggles, type FeatureToggle, isFeatureOnlyChange, NARROW_FEATURE_TABLE } from './feature-scope.ts';
import { forcedPresetPaths, isPresetOnlyChange } from './preset-scope.ts';
import { CORE_GENERATION_META_KEY, CORE_READY_META_KEY, FEATURE_SIGNATURE_META_KEY } from './readiness.ts';
import { createReconcileTiming, prepareReconcile, type ReconcilePaths, type ReconcileSnapshot, type ReconcileTiming, readReconcileSnapshot } from './reconcile.ts';
import { setMeta } from './shared.ts';
import { changedSignatureKeys, embedIdentityAdopted, signatureDiff } from './signature.ts';
import type { Stages } from './stages.ts';
import { withTransaction } from './transaction.ts';
import type { Connection, ReconcileDialect } from './types.ts';

interface BuildResult {
  parsed: number;
  warnings: string[];
  stages: Stages;
  messages: string[];
}

export interface Builder {
  build(): Promise<BuildResult>;
  close(): Promise<void>;
  readonly poolsCreated: number;
}

interface CoreBaseline {
  schemaVersion: string | null;
  features: string | null;
  ready: string | null;
  generation: string | null;
}

interface PlanningSnapshot {
  baseline: CoreBaseline;
  reconcile: ReconcileSnapshot;
  tables: Set<string>;
}

interface PreparedInvalidation {
  mutated: boolean;
  parsed: number;
  apply(conn: Connection): Promise<void>;
}

interface BuildClassification {
  embedKind: ReturnType<typeof classifyEmbedChange>;
  featureToggles: FeatureToggle[];
  forcedPaths?: ReadonlySet<string>;
  fullRebuild: boolean;
  messages: string[];
}

type EnsureFeatureSchema = (cfg: ResolvedConfig) => Promise<void>;

class StaleBuildPlan extends Error {}

const buildPlan = channel('sensemaking.store.build-plan');
const SCHEMA_VERSION_META_KEY = 'schema_version';

async function readCoreBaseline(conn: Connection): Promise<CoreBaseline> {
  const keys = [SCHEMA_VERSION_META_KEY, FEATURE_SIGNATURE_META_KEY, CORE_READY_META_KEY, CORE_GENERATION_META_KEY];
  const stmt = await conn.prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`);
  const values = new Map(((await stmt.all(...keys)) as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
  return {
    schemaVersion: values.get(SCHEMA_VERSION_META_KEY) ?? null,
    features: values.get(FEATURE_SIGNATURE_META_KEY) ?? null,
    ready: values.get(CORE_READY_META_KEY) ?? null,
    generation: values.get(CORE_GENERATION_META_KEY) ?? null,
  };
}

function sameBaseline(a: CoreBaseline, b: CoreBaseline): boolean {
  return a.schemaVersion === b.schemaVersion && a.features === b.features && a.ready === b.ready && a.generation === b.generation;
}

function nextGeneration(value: string | null): string {
  const current = value === null ? 0 : Number(value);
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) throw new SenseError('INDEX_NOT_READY', `the durable core generation is invalid (${value ?? 'missing'}); run sense build --force to recreate the derived index`);
  return String(current + 1);
}

async function readPlanningSnapshot(conn: Connection, timing: ReconcileTiming): Promise<PlanningSnapshot> {
  return withTransaction(conn, async () => {
    const baseline = await readCoreBaseline(conn);
    const reconcile = await readReconcileSnapshot(conn, timing);
    const tablesStmt = await conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = new Set(((await tablesStmt.all()) as Array<{ name: string }>).map((row) => row.name));
    return { baseline, reconcile, tables };
  });
}

function activeSchemaMissing(snapshot: PlanningSnapshot, cfg: Config): boolean {
  for (const feature of FEATURES) {
    if (!featureEnabled(cfg, feature.name)) continue;
    if (feature.name === 'rank') {
      if (!snapshot.reconcile.seenColumns.has('_rank')) return true;
      continue;
    }
    const table = feature.name === 'embed' ? 'embeddings' : NARROW_FEATURE_TABLE[feature.name];
    if (table && !snapshot.tables.has(table)) return true;
  }
  return false;
}

function classifyBuild(snapshot: PlanningSnapshot, cfg: Config, paths: ReconcilePaths, wanted: string): BuildClassification {
  const before = snapshot.baseline.features;
  const recover = snapshot.baseline.ready === '0';
  const messages: string[] = [];
  if (recover) messages.push('sense: recovering an incomplete index generation in place');
  if (!recover && before !== null && before === wanted && activeSchemaMissing(snapshot, cfg)) {
    messages.push('sense: recovering missing feature schema in place');
    return { embedKind: null, featureToggles: [], fullRebuild: true, messages };
  }
  if (recover || before === null || before === wanted) return { embedKind: null, featureToggles: [], fullRebuild: recover, messages };

  const changedKeys = changedSignatureKeys(before, wanted);
  if (changedKeys.size === 1 && changedKeys.has('embed') && embedIdentityAdopted(before, wanted)) {
    messages.push("sense: recorded the embedding model's resolved identity; vectors are unaffected");
    return { embedKind: null, featureToggles: [], fullRebuild: false, messages };
  }

  const embedKind = changedKeys.size === 1 && changedKeys.has('embed') ? classifyEmbedChange(before, wanted) : null;
  if (embedKind !== null) {
    messages.push(embedKind === 'model' ? 'sense: config change (embed settings) invalidates only the stale vectors' : 'sense: config change (embed settings) rebuilds only the embeddings it affects');
    return { embedKind, featureToggles: [], fullRebuild: false, messages };
  }

  const presetForced = isPresetOnlyChange(changedKeys) ? forcedPresetPaths(cfg, paths.rootDir, before, changedKeys) : null;
  if (presetForced !== null) {
    messages.push(`sense: config change (${signatureDiff(before, wanted)}) reparses only the files it affects`);
    return { embedKind: null, featureToggles: [], forcedPaths: presetForced, fullRebuild: false, messages };
  }

  const toggles = isFeatureOnlyChange(changedKeys) ? classifyFeatureToggles(before, wanted, changedKeys) : null;
  if (toggles !== null) {
    messages.push(`sense: config change (${signatureDiff(before, wanted)}) reparses only the feature it affects`);
    return { embedKind: null, featureToggles: toggles, fullRebuild: false, messages };
  }

  messages.push(`sense: config change (${signatureDiff(before, wanted)}) rebuilds the index`);
  return { embedKind: null, featureToggles: [], fullRebuild: true, messages };
}

async function prepareEmbedInvalidation(kind: NonNullable<BuildClassification['embedKind']>, snapshot: PlanningSnapshot, cfg: Config, paths: ReconcilePaths, pool: ParsePool): Promise<PreparedInvalidation> {
  if (kind === 'model') {
    return { mutated: true, parsed: 0, apply: (conn) => conn.exec('UPDATE embeddings SET vector = NULL, scale = NULL') };
  }

  const existing = new Set(snapshot.reconcile.existingRows.map((row) => row.path));
  const files = listFiles(cfg, paths.rootDir).filter((file) => file.embed && existing.has(file.relPath));
  const { docs } = await reparseFiles(files, [embed], cfg, new Set(), undefined, { pool });
  const pathsChanged = docs.map((doc) => doc.relPath);
  const delta: ReconcileDelta = { files, reparsed: pathsChanged, added: [], vanished: [] };
  return {
    mutated: true,
    parsed: docs.length,
    async apply(conn) {
      // Chunk changes can also change the model. Clear every affected row even when
      // its text identity happens to match under the new configuration.
      if (pathsChanged.length > 0)
        await conn.runBatch(
          'DELETE FROM embeddings WHERE "path" = ?',
          pathsChanged.map((path) => [path])
        );
      await embed.store?.(
        conn,
        docs.map((doc) => ({ path: doc.relPath, extracted: doc.extracted.embed })),
        delta
      );
    },
  };
}

async function prepareFeatureInvalidation(toggles: FeatureToggle[], snapshot: PlanningSnapshot, cfg: Config, paths: ReconcilePaths, pool: ParsePool): Promise<PreparedInvalidation> {
  if (toggles.length === 0) return { mutated: false, parsed: 0, apply: async () => {} };
  const prepared = new Map<string, { feature: (typeof FEATURES)[number]; docs: Awaited<ReturnType<typeof reparseFiles>>['docs']; files: ReturnType<typeof listFiles> }>();
  let parsed = 0;
  for (const toggle of toggles) {
    if (!toggle.turnedOn || toggle.name === 'rank') continue;
    const feature = FEATURES.find((candidate) => candidate.name === toggle.name);
    if (!feature) throw new Error(`prepareFeatureInvalidation: no registered feature named "${toggle.name}"`);
    const files = listFiles(cfg, paths.rootDir);
    const { docs } = await reparseFiles(files, [feature], cfg, new Set(), undefined, { pool });
    parsed += docs.length;
    prepared.set(toggle.name, { feature, docs, files });
  }

  const applyTable = async (conn: Connection, toggle: FeatureToggle): Promise<void> => {
    const table = NARROW_FEATURE_TABLE[toggle.name];
    if (!table) return;
    if (!toggle.turnedOn) {
      if (snapshot.tables.has(table)) await conn.exec(`DELETE FROM ${table}`);
      return;
    }
    const plan = prepared.get(toggle.name);
    if (!plan) throw new Error(`prepareFeatureInvalidation: missing prepared feature "${toggle.name}"`);
    const pathsChanged = plan.docs.map((doc) => doc.relPath);
    const delta: ReconcileDelta = { files: plan.files, reparsed: pathsChanged, added: pathsChanged, vanished: [] };
    await conn.exec(`DELETE FROM ${table}`);
    await plan.feature.store?.(
      conn,
      plan.docs.map((doc) => ({ path: doc.relPath, extracted: doc.extracted[plan.feature.name] })),
      delta
    );
    await plan.feature.afterReconcile?.(conn, delta);
  };

  const nullRank = async (conn: Connection): Promise<void> => {
    if (snapshot.reconcile.seenColumns.has('_rank')) await conn.exec('UPDATE frontmatter SET "_rank" = NULL');
  };

  return {
    mutated: true,
    parsed,
    async apply(conn) {
      const byName = new Map(toggles.map((toggle) => [toggle.name, toggle]));
      const linksToggle = byName.get('links');
      if (linksToggle) {
        await applyTable(conn, linksToggle);
        if (!linksToggle.turnedOn) await nullRank(conn);
      }
      const rankToggle = byName.get('rank');
      if (rankToggle) {
        if (rankToggle.turnedOn) await rank.afterReconcile?.(conn, { files: [], reparsed: [], added: [], vanished: [] });
        else await nullRank(conn);
      }
      for (const toggle of toggles) {
        if (toggle.name !== 'links' && toggle.name !== 'rank') await applyTable(conn, toggle);
      }
    },
  };
}

function recoveryToggles(cfg: Config, snapshot: PlanningSnapshot): FeatureToggle[] {
  const toggles: FeatureToggle[] = [];
  for (const feature of FEATURES) {
    const table = NARROW_FEATURE_TABLE[feature.name];
    if (table && !featureEnabled(cfg, feature.name) && snapshot.tables.has(table)) toggles.push({ name: feature.name, turnedOn: false });
  }
  return toggles;
}

async function prepareInvalidation(classification: BuildClassification, snapshot: PlanningSnapshot, cfg: Config, paths: ReconcilePaths, pool: ParsePool): Promise<PreparedInvalidation> {
  const plans: PreparedInvalidation[] = [];
  if (classification.embedKind) plans.push(await prepareEmbedInvalidation(classification.embedKind, snapshot, cfg, paths, pool));
  if (classification.featureToggles.length > 0) plans.push(await prepareFeatureInvalidation(classification.featureToggles, snapshot, cfg, paths, pool));
  if (classification.fullRebuild) {
    plans.push(await prepareFeatureInvalidation(recoveryToggles(cfg, snapshot), snapshot, cfg, paths, pool));
    // Full rebuild and recovery must not reuse vectors from the prior generation.
    if (snapshot.tables.has('embeddings')) {
      plans.push({ mutated: true, parsed: 0, apply: (conn) => conn.exec('DELETE FROM embeddings') });
    }
    if (!featureEnabled(cfg, 'rank') && snapshot.reconcile.seenColumns.has('_rank')) {
      plans.push({ mutated: true, parsed: 0, apply: (conn) => conn.exec('UPDATE frontmatter SET "_rank" = NULL') });
    }
  }
  return {
    mutated: plans.some((plan) => plan.mutated),
    parsed: plans.reduce((sum, plan) => sum + plan.parsed, 0),
    async apply(conn) {
      for (const plan of plans) await plan.apply(conn);
    },
  };
}

function forcedPaths(classification: BuildClassification, snapshot: PlanningSnapshot): ReadonlySet<string> | undefined {
  if (!classification.fullRebuild) return classification.forcedPaths;
  // New paths are reparsed by definition. Forcing every previously indexed path makes every
  // survivor a reparse without a second filesystem scan outside prepareReconcile's one listing.
  return new Set(snapshot.reconcile.existingRows.map((row) => row.path));
}

async function publishAttempt(conn: Connection, liveCfg: ResolvedConfig, dialect: ReconcileDialect, pool: ParsePool, ensureFeatureSchema: EnsureFeatureSchema, timing: ReconcileTiming, attempt: number): Promise<BuildResult> {
  const cfg = structuredClone(liveCfg);
  const configIdentity = JSON.stringify(cfg);
  const paths: ReconcilePaths = { rootDir: cfg.rootDir ?? cfg.baseDir, configDir: cfg.configDir ?? cfg.baseDir };
  const wanted = featureSignature(cfg, FEATURES);
  const snapshot = await readPlanningSnapshot(conn, timing);
  const classification = classifyBuild(snapshot, cfg, paths, wanted);
  const invalidation = await prepareInvalidation(classification, snapshot, cfg, paths, pool);
  const reconcile = await prepareReconcile(snapshot.reconcile, cfg, paths, dialect, timing, pool, forcedPaths(classification, snapshot));
  const mutated = classification.fullRebuild || invalidation.mutated || reconcile.mutated || snapshot.baseline.features !== wanted || snapshot.baseline.ready !== '1';

  if (buildPlan.hasSubscribers) buildPlan.publish({ attempt, baseline: snapshot.baseline, wantedSignature: wanted });
  const txStart = Date.now();
  let txMs: number;
  try {
    await withTransaction(
      conn,
      async () => {
        const current = await readCoreBaseline(conn);
        const currentWanted = featureSignature(liveCfg, FEATURES);
        if (!sameBaseline(current, snapshot.baseline) || JSON.stringify(liveCfg) !== configIdentity || currentWanted !== wanted) {
          throw new StaleBuildPlan('core generation or configuration changed while this build was planning');
        }
        if (!mutated) return;
        await ensureFeatureSchema(cfg);
        await invalidation.apply(conn);
        await reconcile.apply(conn);
        const publishedWanted = featureSignature(liveCfg, FEATURES);
        if (JSON.stringify(liveCfg) !== configIdentity || publishedWanted !== wanted) throw new StaleBuildPlan('configuration changed while this build was publishing');
        await setMeta(conn, FEATURE_SIGNATURE_META_KEY, wanted);
        await setMeta(conn, CORE_READY_META_KEY, '1');
        await setMeta(conn, CORE_GENERATION_META_KEY, nextGeneration(snapshot.baseline.generation));
      },
      dialect.beginMode()
    );
  } finally {
    txMs = Date.now() - txStart;
    timing.txMs += txMs;
  }
  if (reconcile.mutated) await reconcile.record(conn, txMs);
  return {
    parsed: invalidation.parsed + reconcile.parsed,
    warnings: reconcile.warnings,
    stages: reconcile.finish(timing.txMs),
    messages: classification.messages,
  };
}

export function createBuilder(conn: Connection, cfg: ResolvedConfig, dialect: ReconcileDialect, ensureFeatureSchema: EnsureFeatureSchema): Builder {
  const pool = new ParsePool();
  return {
    async build() {
      // One clock and recorder span both bounded attempts. Baseline/catalog reads and feature
      // invalidation preparation are included in totalMs but remain intentionally unlabelled;
      // existing/list/parse and publication stages accumulate under their established labels.
      const timing = createReconcileTiming(cfg);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await publishAttempt(conn, cfg, dialect, pool, ensureFeatureSchema, timing, attempt);
        } catch (err) {
          if (!(err instanceof StaleBuildPlan)) throw err;
          if (attempt === 1) throw new SenseError('STORE_BUSY', 'the index changed during both bounded publication attempts; wait for the competing build to finish and retry');
        }
      }
      throw new Error('unreachable build attempt state');
    },
    close: () => pool.close(),
    get poolsCreated() {
      return pool.poolsCreated;
    },
  };
}

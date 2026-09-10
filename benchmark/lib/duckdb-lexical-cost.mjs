// Bounded DuckDB lexical-path diagnostic. It measures the real lexical adapter through its
// Connection seams; it does not decide a release row or attribute native time to one mechanism.
import { identityHash } from './workload-identity.mjs';

export const DUCKDB_LEXICAL_COST_SCHEMA = 'duckdb-lexical-cost-v1';
export const DUCKDB_LEXICAL_COST_NOTES = [6, 500];
export const DUCKDB_LEXICAL_COST_REPETITIONS = 3;

const BASE_OPTIONS = { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 };
const PHRASE = '"alpha needle"';

const AUTHORED_ROWS = [
  { path: 'adjacent.md', title: '', summary: '', text: 'alpha needle' },
  { path: 'reversed.md', title: '', summary: '', text: 'needle alpha' },
  { path: 'embedded.md', title: '', summary: '', text: 'alphaneedle' },
  { path: 'punctuation.md', title: '', summary: '', text: 'alpha-needle' },
  { path: 'folded.md', title: '', summary: '', text: 'Álphas needles' },
  { path: 'field-boundary.md', title: 'alpha', summary: '', text: 'needle' },
];

// These are literal, independently authored expectations. They deliberately cover the documented
// word, folding/stemming, punctuation, order, and field-boundary contracts without deriving an
// answer from the production tokenizer or query implementation.
const EXPECTED_PATHS = {
  bare: ['adjacent.md', 'field-boundary.md', 'folded.md', 'punctuation.md', 'reversed.md'],
  phrase: ['adjacent.md', 'folded.md', 'punctuation.md'],
  scoped_phrase: ['punctuation.md'],
};

const QUERY_CASES = [
  { id: 'bare', terms: 'needle', options: BASE_OPTIONS, expected: EXPECTED_PATHS.bare },
  { id: 'phrase', terms: PHRASE, options: BASE_OPTIONS, expected: EXPECTED_PATHS.phrase },
  {
    id: 'scoped_phrase',
    terms: PHRASE,
    options: { ...BASE_OPTIONS, scopeCond: 'AND content.path IN (SELECT "path" FROM _duckdb_lexical_cost_scope)', limit: 1 },
    expected: EXPECTED_PATHS.scoped_phrase,
  },
];
const WARMUP_QUERY_ORDER = QUERY_CASES.map(({ id }) => id);

function measuredQueryCases(repetition) {
  const offset = (repetition - 1) % QUERY_CASES.length;
  return [...QUERY_CASES.slice(offset), ...QUERY_CASES.slice(0, offset)];
}

function fixtureRows(notes) {
  if (!DUCKDB_LEXICAL_COST_NOTES.includes(notes)) throw new Error(`notes must be one of ${DUCKDB_LEXICAL_COST_NOTES.join(', ')}`);
  const rows = [...AUTHORED_ROWS];
  for (let i = rows.length; i < notes; i++) rows.push({ path: `filler-${String(i + 1).padStart(3, '0')}.md`, title: '', summary: '', text: `unrelated filler document ${i + 1}` });
  return rows;
}

function assertPaths(actual, expected, label) {
  const paths = actual.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) throw new Error(`${label}: duplicate paths: ${paths.join(', ')}`);
  if (paths.slice().sort().join('\0') !== expected.slice().sort().join('\0')) throw new Error(`${label}: expected paths ${expected.join(', ')}, got ${paths.join(', ')}`);
}

function finite(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and nonnegative`);
}

function errorMessages(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages);
  return [error instanceof Error ? `${error.name}: ${error.message}` : String(error)];
}

// This temporarily decorates the actual connection and its actual statements. It never replaces
// DuckDB, SQL execution, or lexical behavior with a fixture implementation.
function observeConnection(conn) {
  const originalPrepare = conn.prepare;
  const spans = [];
  conn.prepare = async (sql) => {
    const prepareStarted = performance.now();
    const statement = await originalPrepare.call(conn, sql);
    spans.push({ phase: 'prepare', ms: performance.now() - prepareStarted });
    const originalAll = statement.all;
    statement.all = async (...params) => {
      const executeStarted = performance.now();
      const rows = await originalAll.call(statement, ...params);
      spans.push({ phase: 'execute_read_convert', ms: performance.now() - executeStarted });
      return rows;
    };
    return statement;
  };

  return {
    async measure(fn) {
      spans.length = 0;
      const started = performance.now();
      const result = await fn();
      const totalMs = performance.now() - started;
      const prepare = spans.filter(({ phase }) => phase === 'prepare');
      const execute = spans.filter(({ phase }) => phase === 'execute_read_convert');
      if (prepare.length !== 1 || execute.length !== 1) throw new Error(`expected one prepare and one execute/read/convert boundary, got ${prepare.length} and ${execute.length}`);
      const prepareMs = prepare[0].ms;
      const executeReadConvertMs = execute[0].ms;
      const outsideConnectionMs = totalMs - prepareMs - executeReadConvertMs;
      for (const [value, label] of [
        [totalMs, 'total_ms'],
        [prepareMs, 'prepare_ms'],
        [executeReadConvertMs, 'execute_read_convert_ms'],
        [outsideConnectionMs, 'outside_connection_ms'],
      ])
        finite(value, label);
      return {
        result,
        timing: {
          total_ms: totalMs,
          prepare_ms: prepareMs,
          execute_read_convert_ms: executeReadConvertMs,
          outside_connection_ms: outsideConnectionMs,
          limitation: 'execute_read_convert_ms is the @duckdb/node-api run/read/JavaScript-conversion boundary, not pure native execution; outside_connection_ms includes query construction and, for phrases, JavaScript phrase verification.',
        },
      };
    },
    restore() {
      conn.prepare = originalPrepare;
    },
  };
}

async function closeNative(instance, duckdb) {
  let disconnectError;
  try {
    duckdb.disconnectSync();
  } catch (error) {
    disconnectError = error;
  }
  try {
    instance.closeSync();
  } catch (closeError) {
    if (disconnectError) throw new AggregateError([disconnectError, closeError], 'DuckDB cleanup failed');
    throw closeError;
  }
  if (disconnectError) throw disconnectError;
}

async function sample({ DuckDBInstance, createConnection, createLexicalIndex, registerFunctions, notes, repetition }) {
  const rows = fixtureRows(notes);
  const instance = await DuckDBInstance.create(':memory:');
  let duckdb;
  let primaryError;
  let cleanupError;
  let result;
  try {
    duckdb = await instance.connect();
    await registerFunctions(duckdb);
    const conn = createConnection(duckdb);
    await conn.exec('CREATE TABLE content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)');
    await conn.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const insert = await conn.prepare('INSERT INTO content ("path", title, summary, text) VALUES (?, ?, ?, ?)');
    for (const row of rows) await insert.run(row.path, row.title, row.summary, row.text);
    const count = Number((await (await conn.prepare('SELECT COUNT(*) AS n FROM content')).get())?.n);
    if (count !== notes) throw new Error(`expected ${notes} authored content rows, got ${count}`);
    await conn.exec('CREATE TEMP TABLE _duckdb_lexical_cost_scope ("path" TEXT PRIMARY KEY)');
    await (await conn.prepare('INSERT INTO _duckdb_lexical_cost_scope VALUES (?)')).run('punctuation.md');

    const lexical = createLexicalIndex(conn);
    const warmupQueryOrder = [];
    for (const query of QUERY_CASES) {
      const primed = await lexical.query(query.terms, query.options);
      assertPaths(primed, query.expected, `notes ${notes} repetition ${repetition} warmup ${query.id}`);
      warmupQueryOrder.push(query.id);
    }

    const observer = observeConnection(conn);
    try {
      const queries = [];
      const measuredQueries = measuredQueryCases(repetition);
      for (const query of measuredQueries) {
        const observed = await observer.measure(() => lexical.query(query.terms, query.options));
        assertPaths(observed.result, query.expected, `notes ${notes} repetition ${repetition} ${query.id}`);
        queries.push({ id: query.id, terms: query.terms, options: query.options, expected_paths: query.expected, actual_paths: observed.result.map(({ path }) => path), ...observed.timing });
      }
      const native = await (await conn.prepare('SELECT version() AS version')).get();
      if (typeof native?.version !== 'string' || native.version.length === 0) throw new Error('DuckDB version query returned no version');
      result = {
        repetition,
        fixture_rows: rows.length,
        indexed_row_count: count,
        state: { database: 'fresh', index: 'warm', query_shapes: 'warm' },
        warmup_query_order: warmupQueryOrder,
        measured_query_order: measuredQueries.map(({ id }) => id),
        queries,
        native: { version_query: 'SELECT version() AS version', version: native.version },
      };
    } finally {
      observer.restore();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (duckdb) await closeNative(instance, duckdb);
      else instance.closeSync();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError || cleanupError) {
    const errors = [primaryError, cleanupError].filter(Boolean);
    throw new AggregateError(errors, `DuckDB lexical cost sample failed for ${notes} notes, repetition ${repetition}`);
  }
  return result;
}

export async function runDuckdbLexicalCost({ DuckDBInstance, createConnection, createLexicalIndex, registerFunctions }) {
  const samples = [];
  const errors = [];
  for (const notes of DUCKDB_LEXICAL_COST_NOTES) {
    for (let repetition = 1; repetition <= DUCKDB_LEXICAL_COST_REPETITIONS; repetition++) {
      try {
        samples.push({ notes, ...(await sample({ DuckDBInstance, createConnection, createLexicalIndex, registerFunctions, notes, repetition })) });
      } catch (error) {
        const message = errorMessages(error).join('; ');
        samples.push({ notes, repetition, error: message });
        errors.push(`notes ${notes} repetition ${repetition}: ${message}`);
      }
    }
  }
  const fixture = {
    notes: DUCKDB_LEXICAL_COST_NOTES,
    repetitions: DUCKDB_LEXICAL_COST_REPETITIONS,
    rows: AUTHORED_ROWS,
    filler: 'unrelated filler document N',
    expectations: EXPECTED_PATHS,
    row_counts: Object.fromEntries(DUCKDB_LEXICAL_COST_NOTES.map((notes) => [notes, fixtureRows(notes).length])),
    procedure: {
      warmup_query_order: WARMUP_QUERY_ORDER,
      measured_query_orders: Object.fromEntries(Array.from({ length: DUCKDB_LEXICAL_COST_REPETITIONS }, (_unused, index) => [index + 1, measuredQueryCases(index + 1).map(({ id }) => id)])),
    },
  };
  return {
    schema: DUCKDB_LEXICAL_COST_SCHEMA,
    status: errors.length === 0 ? 'success' : 'invalid-measurement',
    valid: errors.length === 0,
    errors,
    method: 'actual createLexicalIndex/queryLexical with temporary observation of real Connection.prepare and Statement.all methods',
    timing_evidence: 'timer-only diagnostic; callers need separate machine-readiness evidence before treating samples as clean performance evidence',
    fixture: { ...fixture, fingerprint: identityHash(fixture) },
    samples,
  };
}

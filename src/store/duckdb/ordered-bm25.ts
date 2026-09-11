import { createHash } from 'node:crypto';
import { SenseError } from '../../errors.ts';
import type { Connection } from '../types.ts';

// This is a connection-local TEMP macro. The contract hash covers the native fts definition,
// DuckDB version, and the reviewed parameter defaults captured in the retained diagnostic.
export const ORDERED_BM25_MACRO = 'sense_ordered_match_bm25';
const SUPPORTED_DUCKDB_VERSION = 'v1.5.5';
const SUPPORTED_CONTRACT_SHA256 = '4476d543e43e7f8c89751cac0659b64e09d906cd3fefb1bfcaf4d15d3b1d9e00';
const EXPECTED_PARAMETERS = ['docname', 'query_string', 'fields', 'k', 'b', 'conjunctive'];
const EXPECTED_DEFAULTS = { fields: 'NULL', k: '1.2', b: '0.75', conjunctive: 'false' } as const;
const EXPECTED_SIGNATURE = `docname, query_string, fields := ${EXPECTED_DEFAULTS.fields}, k := ${EXPECTED_DEFAULTS.k}, b := ${EXPECTED_DEFAULTS.b}, conjunctive := ${EXPECTED_DEFAULTS.conjunctive}`;
const UNORDERED_SUM = 'sum(subscore)';

interface NativeMacroRow {
  function_type: string;
  parameters: unknown;
  parameter_types: unknown;
  macro_definition: string;
}

interface NativeMacroContract {
  version: string;
  macro: NativeMacroRow;
}

function unsupported(message: string): SenseError {
  return new SenseError('STORE_CAPABILITY_MISSING', `store "duckdb" cannot install its deterministic native BM25 adapter: ${message}; update the DuckDB adapter before using lexical search`);
}

function contractSha256(version: string, definition: string): string {
  return createHash('sha256').update(`${version}\0${EXPECTED_SIGNATURE}\0${definition}`).digest('hex');
}

export function validateNativeMacroContract({ version, macro }: NativeMacroContract): string {
  if (version !== SUPPORTED_DUCKDB_VERSION) throw unsupported(`DuckDB ${version} is unsupported (validated version is ${SUPPORTED_DUCKDB_VERSION})`);
  if (macro.function_type !== 'macro') throw unsupported(`match_bm25 is ${macro.function_type}, not a macro`);
  if (JSON.stringify(macro.parameters) !== JSON.stringify(EXPECTED_PARAMETERS)) throw unsupported(`match_bm25 parameters changed (${JSON.stringify(macro.parameters)})`);
  if (!Array.isArray(macro.parameter_types) || macro.parameter_types.some((type) => type !== null)) throw unsupported('match_bm25 parameter types changed');
  if (contractSha256(version, macro.macro_definition) !== SUPPORTED_CONTRACT_SHA256) throw unsupported('match_bm25 definition or reviewed parameter-default contract changed');
  if (macro.macro_definition.split(UNORDERED_SUM).length !== 2) throw unsupported('match_bm25 does not contain exactly one validated unordered subscore sum');
  return macro.macro_definition.replace(UNORDERED_SUM, 'sum(subscore ORDER BY subscore)');
}

export async function ensureOrderedBm25(conn: Connection, state: { orderedMacroReady: boolean }): Promise<void> {
  if (state.orderedMacroReady) return;
  const versionStatement = await conn.prepare('SELECT version() AS version');
  const versionRow = (await versionStatement.get()) as { version: string };
  const macroStatement = await conn.prepare(`
    SELECT function_type, parameters, parameter_types, macro_definition
    FROM duckdb_functions()
    WHERE schema_name = 'fts_main_content' AND function_name = 'match_bm25'
  `);
  const macro = (await macroStatement.get()) as NativeMacroRow | undefined;
  if (!macro) throw unsupported('fts_main_content.match_bm25 is missing');
  const orderedDefinition = validateNativeMacroContract({ version: versionRow.version, macro });
  await conn.exec(`CREATE OR REPLACE TEMP MACRO ${ORDERED_BM25_MACRO}(${EXPECTED_SIGNATURE}) AS ${orderedDefinition}`);
  state.orderedMacroReady = true;
}

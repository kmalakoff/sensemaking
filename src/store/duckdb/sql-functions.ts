import type { DuckDBConnection } from '@duckdb/node-api';
import { segmentMatch } from '../../text/segment.ts';
import { basenameImpl, hasImpl } from '../sql-functions.ts';
import { duckdbApi } from './native.ts';

// Dynamic, not a top-level import: sqlite trees must never attempt to resolve this optional peer dependency (open.ts's connect()).
// Goes through native.ts's shared duckdbApi(), not its own bare import, since a second independent lookup would hit Node's stale pre-install resolution miss.
export async function registerFunctions(conn: DuckDBConnection): Promise<void> {
  const { DuckDBIntegerType, DuckDBScalarFunction, DuckDBVarCharType } = await duckdbApi();
  conn.registerScalarFunction(
    DuckDBScalarFunction.create({
      name: 'has',
      parameterTypes: [DuckDBVarCharType.instance, DuckDBVarCharType.instance],
      returnType: DuckDBIntegerType.instance,
      mainFunction(_info, inputChunk, outputVector) {
        const fieldVec = inputChunk.getColumnVector(0);
        const valueVec = inputChunk.getColumnVector(1);
        for (let i = 0; i < inputChunk.rowCount; i++) outputVector.setItem(i, hasImpl(fieldVec.getItem(i), valueVec.getItem(i)));
        outputVector.flush();
      },
    })
  );
  conn.registerScalarFunction(
    DuckDBScalarFunction.create({
      name: 'basename',
      parameterTypes: [DuckDBVarCharType.instance],
      varArgsType: DuckDBVarCharType.instance,
      returnType: DuckDBVarCharType.instance,
      mainFunction(_info, inputChunk, outputVector) {
        const pathVec = inputChunk.getColumnVector(0);
        const suffixVec = inputChunk.columnCount > 1 ? inputChunk.getColumnVector(1) : null;
        for (let i = 0; i < inputChunk.rowCount; i++) outputVector.setItem(i, basenameImpl(pathVec.getItem(i), suffixVec ? suffixVec.getItem(i) : undefined));
        outputVector.flush();
      },
    })
  );
  // segment() rewrites unspaced-script runs into the grapheme phrase FTS5's `_seg` sidecars need (text/segment.ts); this store's own
  // lexical index uses contains() instead and never calls this, but hand-written raw SQL naming it gets the real implementation, not a silent passthrough (PRINCIPLES: no-silent-modes).
  conn.registerScalarFunction(
    DuckDBScalarFunction.create({
      name: 'segment',
      parameterTypes: [DuckDBVarCharType.instance],
      returnType: DuckDBVarCharType.instance,
      mainFunction(_info, inputChunk, outputVector) {
        const textVec = inputChunk.getColumnVector(0);
        for (let i = 0; i < inputChunk.rowCount; i++) outputVector.setItem(i, segmentMatch(String(textVec.getItem(i) ?? '')));
        outputVector.flush();
      },
    })
  );
}

const D1_MAX_BOUND_PARAMETERS = 100;

/** Split bulk rows so each prepared D1 statement stays below its bind limit. */
export function splitRowsForD1<T>(rows: readonly T[], parametersPerRow: number, trailingParameters = 0): T[][] {
  const capacity = Math.floor((D1_MAX_BOUND_PARAMETERS - trailingParameters) / parametersPerRow);
  if (!Number.isInteger(parametersPerRow) || parametersPerRow < 1 || capacity < 1 || trailingParameters < 0) {
    throw new Error('D1 statement bind limit cannot fit one row');
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += capacity) chunks.push(rows.slice(offset, offset + capacity));
  return chunks;
}

export const D1_MAX_BOUND_PARAMETERS_PER_STATEMENT = D1_MAX_BOUND_PARAMETERS;

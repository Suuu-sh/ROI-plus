/** Compatibility view: old pool-quality messages were written as failed errors.
 * Never rewrite stored history, and never hide the non-quality part of a mixed run.
 */
export function collectionIssues(run: { error?: string | null; reason?: string | null }) {
  const legacy = (run.error ?? '').split('; ').filter(Boolean);
  const quality = legacy.filter(message => message.includes('odds pool not stable (overround out of range)'));
  const failures = legacy.filter(message => !message.includes('odds pool not stable (overround out of range)'));
  if (run.reason?.startsWith('quality_excluded: ')) quality.push(...run.reason.slice('quality_excluded: '.length).split(' | '));
  return { quality, error: failures.join('; ') || null };
}

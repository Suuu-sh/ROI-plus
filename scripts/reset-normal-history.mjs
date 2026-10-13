import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = 'https://roi-plus-api.suuu-sh.workers.dev/api/ingest/normal-history';
const confirmation = 'RESET NORMAL PURCHASE HISTORY ONLY';
const token = process.env.INGEST_TOKEN;
const mode = process.argv[2];
if (!token || !['--backup', '--reset'].includes(mode) || process.env.RESET_CONFIRMATION !== confirmation || !/^[a-f0-9]{40}$/.test(process.env.APPROVED_SOURCE_SHA ?? '') || process.env.APPROVED_SOURCE_SHA !== process.env.GITHUB_SHA) throw new Error('exact source, approval, and operator credentials required');
async function request(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`normal history operator request failed (${response.status})`);
  return response.json();
}
const hash = value => createHash('sha256').update(value).digest('hex');
const protectedTables = ['paper_decisions', 'experimental_paper_bets', 'experimental_paper_decisions', 'experimental_bankroll'];
if (mode === '--backup') {
  const snapshot = await request('/snapshot');
  await writeFile('normal-history-backup.json', JSON.stringify(snapshot), { mode: 0o600 });
  console.log(JSON.stringify({ backupBets: JSON.parse(snapshot.tables.bets).length, backupDailySummaries: JSON.parse(snapshot.tables.daily_summaries).length, experimentalBets: JSON.parse(snapshot.tables.experimental_paper_bets).length, experimentalChecksum: hash(snapshot.tables.experimental_paper_bets), initialBankroll: Number(snapshot.initialBankroll) }));
} else {
  const snapshot = JSON.parse(await readFile('normal-history-backup.json', 'utf8'));
  const result = await request('/reset', { confirmation, snapshot });
  const after = await request('/snapshot');
  if (JSON.parse(after.tables.bets).length || JSON.parse(after.tables.daily_summaries).length || after.initialBankroll !== snapshot.initialBankroll) throw new Error('normal reset verification failed');
  const preservation = Object.fromEntries(protectedTables.map(t => [t, { beforeCount: JSON.parse(snapshot.tables[t]).length, afterCount: JSON.parse(after.tables[t]).length, beforeSha256: hash(snapshot.tables[t]), afterSha256: hash(after.tables[t]), unchanged: snapshot.tables[t] === after.tables[t] }]));
  if (protectedTables.some(t => !preservation[t].unchanged)) throw new Error('protected purchase state changed; inspect possible concurrent settlement');
  const report = { ...result, normalBetsAfter: 0, dailySummariesAfter: 0, preservation };
  await writeFile('normal-history-reset-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Normal purchase reset\n\nDeleted normal bets: ${result.deletedBets}; daily summaries: ${result.deletedDailySummaries}. Normal initial balance unchanged: ${result.initialBankroll}.\n\nExperimental bets, decisions, bankroll and normal decision audit: exact row checksums unchanged. Backup artifact: normal-history-backup-${process.env.GITHUB_RUN_ID}.\n`);
}

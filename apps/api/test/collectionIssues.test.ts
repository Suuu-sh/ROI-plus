import { describe, expect, it } from 'vitest';
import { collectionIssues } from '../src/services/collectionIssues.js';
describe('collection issue compatibility', () => {
  it('separates legacy pool skips from a mixed transport failure', () => {
    expect(collectionIssues({error:'race-a: odds pool not stable (overround out of range); race-b: HTTP 503'})).toEqual({quality:['race-a: odds pool not stable (overround out of range)'],error:'race-b: HTTP 503'});
  });
  it('reads new quality reasons without swallowing parse failures', () => {
    expect(collectionIssues({error:'official win odds table missing',reason:'quality_excluded: race-a: pool | race-b: pool'})).toEqual({quality:['race-a: pool','race-b: pool'],error:'official win odds table missing'});
  });
});

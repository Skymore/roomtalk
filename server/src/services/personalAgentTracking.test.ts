import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersonalAgentTrackingService } from './personalAgentTracking';
import { PersonalAgentBrowserError } from './personalAgentBrowser';
import { PersonalAgentWatch } from '../types';

const watch = { id: 'watch', clientId: 'owner', roomId: 'private', url: 'https://example.org/', condition: 'change', value: '',
  status: 'active', epoch: 0, checks: 1, lastText: 'Confirmed source', matched: false } as PersonalAgentWatch;
const logger = { error() {}, warn() {} } as any;
describe('actual browser tracking publication', () => {
  it('records HTTP errors without interpreting their body as a changed source', async () => {
    const saved: any[] = []; let released = 0;
    const service = new PersonalAgentTrackingService({
      async readPersonalAgentWatches() { return { watches: [watch] }; },
      async finishPersonalAgentWatchCheck(outcome: any) { saved.push(outcome); return null; },
    } as any, {
      async takeControl() { return { control: { id: 'control', fence: 3 } }; },
      async manual() { return { httpStatus: 503, session: { url: watch.url, title: 'Unavailable' }, text: 'Changed error page' }; },
      async releaseControl() { released++; },
    } as any, {} as any, logger);
    await service.check(watch);
    assert.equal(saved[0].error, 'Page returned HTTP 503'); assert.equal(saved[0].observation, undefined); assert.equal(released, 1);
  });
  it('leaves a busy browser alone and does not count it as a page failure', async () => {
    const service = new PersonalAgentTrackingService({ async finishPersonalAgentWatchCheck() { assert.fail('Busy is not a failed check'); } } as any,
      { async takeControl() { throw new PersonalAgentBrowserError('User is browsing', 409); } } as any, {} as any, logger);
    await service.check(watch);
  });
  it('does not reinterpret a database publication failure as a failed page check', async () => {
    let saves = 0, released = false;
    const service = new PersonalAgentTrackingService({
      async readPersonalAgentWatches() { return { watches: [watch] }; },
      async finishPersonalAgentWatchCheck() { saves++; throw new Error('Database unavailable'); },
    } as any, {
      async takeControl() { return { control: { id: 'control', fence: 3 } }; },
      async manual() { return { httpStatus: 200, session: { url: watch.url, title: 'Actual page' }, text: 'Actual changed page' }; },
      async releaseControl() { released = true; },
    } as any, {} as any, logger);
    await assert.rejects(service.check(watch), /Database unavailable/);
    assert.equal(saves, 1); assert.equal(released, true);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { PgModule, RoomEventNotifier } from './roomEventNotifier';

type Listener = (value?: any) => void;

class FakeNotificationClient {
  readonly listeners = new Map<string, Listener>();
  readonly calls: string[] = [];

  async connect() {
    this.calls.push('connect');
  }

  async query(sql: string) {
    this.calls.push(sql);
  }

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
    return this;
  }

  async end() {
    this.calls.push('end');
  }

  emit(event: string, value?: any) {
    this.listeners.get(event)?.(value);
  }
}

describe('RoomEventNotifier', () => {
  it('requests local anti-entropy only after a successful re-LISTEN', async () => {
    const clients: FakeNotificationClient[] = [];
    const order: string[] = [];
    const pgModule = {
      Client: class extends FakeNotificationClient {
        constructor() {
          super();
          const instanceNumber = clients.length + 1;
          const originalQuery = this.query.bind(this);
          this.query = async (sql: string) => {
            await originalQuery(sql);
            if (sql === 'LISTEN room_event_committed') order.push(`listen-${instanceNumber}`);
          };
          clients.push(this);
        }
      },
    } as unknown as PgModule;
    const notifier = new RoomEventNotifier(
      'postgresql://test',
      new Logger('RoomEventNotifierTest'),
      () => undefined,
      () => order.push('sync-required'),
      pgModule,
      1,
    );

    await notifier.start();
    assert.deepEqual(order, ['listen-1']);

    clients[0].emit('error', new Error('listener dropped'));
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(clients.length, 2);
    assert.deepEqual(order, ['listen-1', 'listen-2', 'sync-required']);
    await notifier.stop();
  });
});

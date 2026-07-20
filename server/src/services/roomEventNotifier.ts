import { Logger } from '../logger';
import { resolvePostgresSslConfig } from '../repositories/postgresPool';

export interface RoomEventAvailable {
  roomId: string;
  headSeq: number;
}

interface PgNotification {
  channel: string;
  payload?: string;
}

interface PgNotificationClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', listener: (message: PgNotification) => void): this;
  on(event: 'error' | 'end', listener: (error?: Error) => void): this;
  end(): Promise<void>;
}

type PgModule = {
  Client: new (config: {
    connectionString: string;
    ssl?: { rejectUnauthorized: boolean; ca?: string } | boolean;
  }) => PgNotificationClient;
};

const RECONNECT_DELAY_MS = 1_000;

export class RoomEventNotifier {
  private client: PgNotificationClient | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionGeneration = 0;

  constructor(
    private readonly databaseUrl: string,
    private readonly logger: Logger,
    private readonly onEventAvailable: (event: RoomEventAvailable) => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connectionGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      await client.end().catch(error => {
        this.logger.warn('Failed to close PostgreSQL room event listener', { error });
      });
    }
  }

  private async connect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    const pg = require('pg') as PgModule;
    const client = new pg.Client({
      connectionString: this.databaseUrl,
      ssl: resolvePostgresSslConfig(),
    });
    this.client = client;

    client.on('notification', message => {
      if (message.channel !== 'room_event_committed' || !message.payload) return;
      try {
        const parsed = JSON.parse(message.payload) as Partial<RoomEventAvailable>;
        if (
          typeof parsed.roomId === 'string'
          && parsed.roomId.length > 0
          && Number.isSafeInteger(parsed.headSeq)
          && Number(parsed.headSeq) > 0
        ) {
          this.onEventAvailable({ roomId: parsed.roomId, headSeq: Number(parsed.headSeq) });
        }
      } catch (error) {
        this.logger.warn('Ignored malformed PostgreSQL room event notification', { error });
      }
    });
    client.on('error', error => {
      this.logger.warn('PostgreSQL room event listener error', { error });
      this.scheduleReconnect(generation);
    });
    client.on('end', () => {
      this.scheduleReconnect(generation);
    });

    try {
      await client.connect();
      await client.query('LISTEN room_event_committed');
      this.logger.info('Listening for committed room events');
    } catch (error) {
      if (this.client === client) this.client = null;
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  private scheduleReconnect(generation: number): void {
    if (this.stopped || generation !== this.connectionGeneration || this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connect().catch(error => {
        this.logger.warn('Failed to reconnect PostgreSQL room event listener', { error });
        this.scheduleReconnect(this.connectionGeneration);
      });
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}

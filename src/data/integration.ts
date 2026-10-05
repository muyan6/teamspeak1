import type Database from 'better-sqlite3';

export interface BotLease {
  expiresAt: number | null;
  suspended: boolean;
  revision: number;
}
export interface ManagedService extends BotLease {
  serviceId: string;
  botId: string;
  payloadHash: string;
  deleted: boolean;
}
export class IntegrationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function leaseAllowsRun(lease: BotLease | null, now = Date.now()): boolean {
  return !lease || (!lease.suspended && (lease.expiresAt === null || lease.expiresAt > now));
}

/** Separate, additive schema: legacy standalone bots remain unmanaged. */
export function createIntegrationStore(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS integration_services (
    serviceId TEXT PRIMARY KEY, botId TEXT NOT NULL UNIQUE, payloadHash TEXT NOT NULL,
    expiresAt INTEGER, suspended INTEGER NOT NULL, revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`);
  const read = (row: unknown): ManagedService | null => row ? {
    ...(row as ManagedService), suspended: !!(row as ManagedService).suspended,
    deleted: !!(row as ManagedService).deleted,
  } : null;
  const byService = db.prepare('SELECT * FROM integration_services WHERE serviceId=?');
  const byBot = db.prepare('SELECT * FROM integration_services WHERE botId=?');
  return {
    getByService: (id: string) => read(byService.get(id)),
    getByBot: (id: string) => read(byBot.get(id)),
    insert(service: ManagedService) {
      db.prepare('INSERT INTO integration_services VALUES (?,?,?,?,?,?,?)').run(
        service.serviceId, service.botId, service.payloadHash, service.expiresAt,
        Number(service.suspended), service.revision, Number(service.deleted),
      );
    },
    setLease(botId: string, lease: BotLease): ManagedService {
      return db.transaction(() => {
        const current = read(byBot.get(botId));
        if (current?.deleted) throw new IntegrationError('Service has been deleted', 410);
        if (current && (lease.revision < current.revision ||
          (lease.revision === current.revision && (lease.expiresAt !== current.expiresAt || lease.suspended !== current.suspended)))) {
          throw new IntegrationError('Stale or conflicting lease revision', 409);
        }
        if (!current) {
          // Admin-only adoption of an existing standalone bot during upgrade.
          db.prepare('INSERT INTO integration_services VALUES (?,?,?,?,?,?,0)').run(
            `adopted:${botId}`, botId, '', lease.expiresAt, Number(lease.suspended), lease.revision,
          );
        } else {
          db.prepare('UPDATE integration_services SET expiresAt=?, suspended=?, revision=? WHERE botId=?').run(
            lease.expiresAt, Number(lease.suspended), lease.revision, botId,
          );
        }
        return read(byBot.get(botId))!;
      })();
    },
    markDeleted(botId: string) {
      db.prepare('UPDATE integration_services SET deleted=1, suspended=1 WHERE botId=?').run(botId);
    },
  };
}

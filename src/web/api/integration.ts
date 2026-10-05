import { Router } from 'express';
import { createHash } from 'node:crypto';
import type { BotManager, CreateBotParams } from '../../bot/manager.js';
import { IntegrationError, type BotLease } from '../../data/integration.js';

function leaseInput(value: unknown): BotLease {
  const lease = value as Partial<BotLease> | undefined;
  if (!lease || typeof lease.suspended !== 'boolean' || !Number.isSafeInteger(lease.revision) || lease.revision! < 1 ||
    !(lease.expiresAt === null || (Number.isSafeInteger(lease.expiresAt) && lease.expiresAt! >= 0))) {
    throw new IntegrationError('lease requires expiresAt (epoch milliseconds or null), suspended and positive revision', 400);
  }
  return { expiresAt: lease.expiresAt!, suspended: lease.suspended, revision: lease.revision! };
}
function botInput(value: unknown): CreateBotParams {
  const input = value as Record<string, unknown> | undefined;
  const text = (key: string, max: number, required = false): string => {
    const value = input?.[key];
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new IntegrationError(`Invalid ${key}`, 400);
    return value;
  };
  const serverPort = input?.serverPort ?? 9987;
  if (!Number.isInteger(serverPort) || Number(serverPort) < 1 || Number(serverPort) > 65535) throw new IntegrationError('Invalid serverPort', 400);
  return { name: text('name', 100, true), serverAddress: text('serverAddress', 255, true),
    serverPort: Number(serverPort), nickname: text('nickname', 100, true), defaultChannel: text('defaultChannel', 512),
    channelId: text('channelId', 128), channelPassword: text('channelPassword', 1024), serverPassword: text('serverPassword', 1024),
    // Provisioning does not enable boot-time connection until an explicit start succeeds.
    autoStart: false };
}

/** Mounted behind session authentication + requireAdmin, never tenant-grantable. */
export function createIntegrationRouter(manager: BotManager): Router {
  const router = Router();
  router.get('/capabilities', (_req, res) => res.json({ version: 1, atomicUserPermissions: true, idempotentBots: true, leases: true }));
  router.post('/bots', async (req, res, next) => {
    try {
      const serviceId = req.body?.serviceId;
      if (typeof serviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(serviceId)) throw new IntegrationError('Invalid serviceId', 400);
      const params = botInput(req.body?.bot);
      const lease = leaseInput(req.body?.lease);
      const payloadHash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
      const result = await manager.createManagedBot(serviceId, payloadHash, params, lease);
      res.status(result.created ? 201 : 200).json({ id: result.bot.id, serviceId });
    } catch (err) { next(err); }
  });
  router.get('/services/:serviceId', (req, res, next) => {
    try {
      const record = manager.getManagedService(req.params.serviceId);
      if (!record) throw new IntegrationError('Service not found', 404);
      const { payloadHash: _, ...view } = record;
      res.json(view);
    } catch (err) { next(err); }
  });
  router.delete('/services/:serviceId', async (req, res, next) => {
    try {
      await manager.cancelManagedService(req.params.serviceId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
  router.put('/bots/:botId/lease', (req, res, next) => {
    try {
      manager.setBotLease(req.params.botId, leaseInput(req.body));
      res.json({ success: true });
    } catch (err) { next(err); }
  });
  router.use((err: Error & { status?: number }, _req: any, res: any, _next: any) => {
    res.status(err instanceof IntegrationError ? err.status : 500).json({ error: err instanceof IntegrationError ? err.message : 'Integration operation failed' });
  });
  return router;
}

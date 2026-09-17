import { Router } from 'express';

import type { Env } from '../config/env.ts';
import { createServiceClient } from '../db/supabase.ts';

export interface HealthCheck {
  /** True when the database answers a trivial query with the backend's credentials. */
  database(): Promise<boolean>;
}

export function createSupabaseHealthCheck(env: Env): HealthCheck {
  const service = createServiceClient(env);
  return {
    async database() {
      const { error } = await service.rpc('get_kb_meta');
      return error === null;
    },
  };
}

/**
 * `GET /health` is a cheap liveness probe. `GET /health?deep=1` also touches the
 * database; the keep-alive pinger uses it so neither Render nor Supabase idles out.
 */
export function createHealthRouter(check: HealthCheck): Router {
  const router = Router();

  router.get('/health', async (req, res) => {
    if (req.query.deep === undefined) {
      res.json({ status: 'ok' });
      return;
    }
    const databaseOk = await check.database().catch(() => false);
    res.status(databaseOk ? 200 : 503).json({ status: databaseOk ? 'ok' : 'degraded', database: databaseOk ? 'ok' : 'unavailable' });
  });

  return router;
}

import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser } from '../auth/require-auth.ts';
import { HttpError } from '../http/errors.ts';
import type { ConversationStore } from './store.ts';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.iso.datetime({ offset: true }).optional(),
});

const conversationIdSchema = z.uuid();

function parseConversationId(value: string | undefined): string {
  const result = conversationIdSchema.safeParse(value);
  // A malformed id and someone else's id are indistinguishable to the client.
  if (!result.success) throw new HttpError(404, 'not_found', 'Conversation not found');
  return result.data;
}

export function createConversationRouter(store: ConversationStore): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new HttpError(400, 'bad_request', 'Invalid query parameters', query.error.issues.map((issue) => issue.path.join('.')));
    }
    const conversations = await store.list(getAuthUser(res), query.data);
    const nextCursor = conversations.length === query.data.limit ? conversations.at(-1)!.updatedAt : null;
    res.json({ conversations, nextCursor });
  });

  router.get('/:id/messages', async (req, res) => {
    const result = await store.getWithMessages(getAuthUser(res), parseConversationId(req.params.id));
    if (!result) throw new HttpError(404, 'not_found', 'Conversation not found');
    res.json(result);
  });

  router.delete('/:id', async (req, res) => {
    const deleted = await store.delete(getAuthUser(res), parseConversationId(req.params.id));
    if (!deleted) throw new HttpError(404, 'not_found', 'Conversation not found');
    res.status(204).end();
  });

  return router;
}

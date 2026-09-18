import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { API_ERROR_CODES } from '../src/api/errors.ts';
import { CHAT_MESSAGE_FIELDS, INTENTS, MAX_MESSAGE_CHARS, MESSAGE_STATUSES } from '../src/api/types.ts';

/**
 * The frontend mirrors the backend contract by hand (separate packages, no codegen).
 * These tests read the backend source so a change there fails the frontend build
 * instead of silently breaking at runtime. They never modify the backend.
 */
const apiSrc = path.resolve(import.meta.dirname, '../../api/src');
const read = (relative: string) => readFile(path.join(apiSrc, relative), 'utf8');

function unionValues(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([^;]+);`).exec(source);
  assert.ok(match, `could not find "export type ${typeName}" in the backend source`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('frontend/backend contract', () => {
  it('mirrors the Intent and MessageStatus unions', async () => {
    const source = await read('conversations/types.ts');
    assert.deepEqual(unionValues(source, 'Intent'), [...INTENTS]);
    assert.deepEqual(unionValues(source, 'MessageStatus'), [...MESSAGE_STATUSES]);
  });

  it('mirrors every ChatMessage field', async () => {
    const source = await read('conversations/types.ts');
    const block = /export interface ChatMessage \{([\s\S]*?)\n\}/.exec(source);
    assert.ok(block, 'could not find the ChatMessage interface');
    const fields = [...block[1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    assert.deepEqual(fields.sort(), [...CHAT_MESSAGE_FIELDS].sort());
  });

  it('mirrors the Source shape', async () => {
    const source = await read('conversations/types.ts');
    const block = /export interface Source \{([\s\S]*?)\n\}/.exec(source);
    assert.ok(block);
    const fields = [...block[1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    assert.deepEqual(fields.sort(), ['kind', 'title', 'url']);
    assert.match(block[1]!, /kind:\s*'qobo'\s*\|\s*'web'/);
  });

  it('mirrors the message length limit', async () => {
    const source = await read('chat/routes.ts');
    const match = /export const MAX_MESSAGE_CHARS = ([\d_]+)/.exec(source);
    assert.ok(match, 'could not find MAX_MESSAGE_CHARS in the backend source');
    assert.equal(Number(match[1]!.replace(/_/g, '')), MAX_MESSAGE_CHARS);
  });

  it('covers every backend error code', async () => {
    const source = await read('http/errors.ts');
    const block = /export type ErrorCode =([\s\S]*?);/.exec(source);
    assert.ok(block, 'could not find the ErrorCode union');
    const backendCodes = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const missing = backendCodes.filter((code) => !(API_ERROR_CODES as readonly string[]).includes(code));
    assert.deepEqual(missing, [], `frontend has no handling for: ${missing.join(', ')}`);
  });

  it('matches the chat request fields the backend validates', async () => {
    const source = await read('chat/routes.ts');
    const block = /const chatRequestSchema = z\s*\.object\(\{([\s\S]*?)\n\s{2}\}\)/.exec(source);
    assert.ok(block, 'could not find chatRequestSchema in the backend source');
    const fields = [...block[1]!.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
    assert.deepEqual(fields.sort(), ['clientMessageId', 'conversationId', 'message', 'replaceMessageId']);
  });
});

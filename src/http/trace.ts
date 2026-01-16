import { randomUUID } from 'crypto';

export function makeTraceId(): string {
  return randomUUID();
}

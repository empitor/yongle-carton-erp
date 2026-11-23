import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import type { Actor } from './actor.js';

/** 请求的登录身份、会话和凭证。 */
export interface RequestAuth {
  readonly csrf: string;
  actor(req: IncomingMessage): Actor | null;
  signedIn(req: IncomingMessage): Actor;
  sessionBinding(req: IncomingMessage): string;
  requireCsrf(req: Request): void;
  verifyPassword(req: Request, password: unknown): Promise<Actor>;
}

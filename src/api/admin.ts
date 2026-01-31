import { FastifyRequest } from 'fastify';
import { Config } from '../config';

export class AdminGuard {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  isEnabled() {
    return this.config.adminEnabled;
  }

  authorize(request: FastifyRequest): boolean {
    if (!this.config.adminEnabled) return false;
    const token = this.config.adminToken;
    if (!token) return false;
    const header = request.headers['authorization'];
    if (!header || typeof header !== 'string') return false;
    const match = header.match(/^Bearer\s+(.*)$/i);
    if (!match) return false;
    return match[1] === token;
  }
}

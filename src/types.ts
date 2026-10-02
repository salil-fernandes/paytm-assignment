import { FastifyRequest } from "fastify";

export interface AuthenticatedUser {
  userId: string;
  role?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    userId?: string;
    correlationId: string;
  }
}

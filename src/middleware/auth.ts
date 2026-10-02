import { FastifyRequest, FastifyReply } from "fastify";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply
      .status(401)
      .send({ error: "Missing or malformed Authorization header" });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return reply.status(401).send({ error: "Empty bearer token" });
  }

  // Identity is token-derived: map the bearer token directly to userId
  // e.g. "Bearer user_alice" -> userId: "user_alice"
  request.user = {
    userId: token,
    role: token.startsWith("admin") ? "admin" : "user",
  };
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  await authenticate(request, reply);
  if (reply.sent) return;

  if (request.user?.role !== "admin" && request.user?.userId !== "admin") {
    return reply.status(403).send({ error: "Admin privileges required" });
  }
}

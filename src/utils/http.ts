import type express from "express";

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isAllowedLocalOrigin(origin?: string): boolean {
  if (!origin) return true;
  return LOCAL_ORIGIN_RE.test(origin);
}

/**
 * Enforce loopback-only CORS for local HTTP servers so arbitrary third-party web pages
 * cannot invoke localhost tools or read local channel messages from a user's browser,
 * while permitting non-browser local clients (which send no `Origin` header).
 */
export function localCorsMiddleware(methods: string): express.RequestHandler {
  return (req, res, next) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && !isAllowedLocalOrigin(origin)) {
      res.status(403).json({ error: "Forbidden origin" });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", methods);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  };
}


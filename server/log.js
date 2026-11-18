// Server-side error reports, written to stderr so they show up in `docker logs`.

/** One readable block for an unexpected (500) error: when, which request, who, then the full stack trace. */
export function describeServerError(err, { method, path, user, at = new Date() } = {}) {
  const who = user ? `${user.name} (#${user.id}, ${user.role})` : 'anonymous';
  const stack = (err instanceof Error ? err.stack || `${err.name}: ${err.message}` : `Non-error thrown: ${String(err)}`);
  const extra = err && typeof err === 'object' && err.code ? ` [code ${err.code}]` : '';
  return `[${at.toISOString()}] 500 on ${method ?? '?'} ${path ?? '?'} by ${who}${extra}\n${stack}`;
}

export const logServerError = (err, info) => console.error(describeServerError(err, info));

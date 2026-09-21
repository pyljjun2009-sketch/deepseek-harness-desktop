/** Probe only the bare origin; 401 means the authenticated DSH server is alive. */
export function isHealthyHttpStatus(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  return status === 401;
}

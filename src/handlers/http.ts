export type HandlerResult = { status: number; json: any };

export function getHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  key: string,
): string | undefined {
  if (!headers) return undefined;
  const v = (headers as any)[key.toLowerCase()] ?? (headers as any)[key];
  if (!v) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export function asErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}


export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  timeoutMs?: number;
  label?: string;
  onRetry?: (attempt: number, err: unknown) => void;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'operação'): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout de ${ms}ms em ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

/** Retry com backoff exponencial + jitter e timeout por tentativa. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  const label = opts.label ?? 'operação';
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const call = opts.timeoutMs ? withTimeout(fn(), opts.timeoutMs, label) : fn();
      return await call;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      opts.onRetry?.(attempt + 1, err);
      const delay = Math.min(maxMs, baseMs * 2 ** attempt) + Math.random() * baseMs;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label} falhou após ${retries + 1} tentativas: ${String(lastErr)}`);
}

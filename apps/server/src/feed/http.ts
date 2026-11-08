// Errors a venue can give that change how the feed behaves.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response, fallbackMs: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header ? Math.trunc(parseInt(header, 10)) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

// GET a JSON body. Rate limits (429, and Binance's 418) wait and try again up to 5 times;
// other failures throw an HttpError. The URL is logged on failure, headers never are.
export async function getJson<T>(
  url: string,
  headers: Record<string, string> = {},
  rateLimitFallbackMs = 60_000,
): Promise<T> {
  let waitMs = 1_000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
    if (res.ok) return (await res.json()) as T;
    const body = await res.text().catch(() => '');
    if ((res.status === 429 || res.status === 418) && attempt < 5) {
      await sleep(Math.max(retryAfterMs(res, rateLimitFallbackMs), waitMs));
      waitMs *= 2;
      continue;
    }
    throw new HttpError(res.status, `${res.status} from ${new URL(url).host}${new URL(url).pathname}: ${body.slice(0, 200)}`);
  }
}

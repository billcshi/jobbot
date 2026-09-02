import { promises as dns } from 'node:dns';
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { combinedAbortSignal } from './http-json.js';
import { parseHttpUrl } from './url.js';

const BLOCKED_IPV4 = new BlockList();
const BLOCKED_IPV6 = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_IPV4.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_IPV6.addSubnet(network, prefix, 'ipv6');
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SafeExternalFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolveHost?: ResolveHost;
  userAgent?: string;
}

export interface ExternalTextResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: IncomingHttpHeaders;
  text: string;
}

export class UnsafeExternalUrlError extends Error {}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_IPV4.check(address, 'ipv4');
  if (family === 6) return !BLOCKED_IPV6.check(address, 'ipv6');
  return false;
}

export function rejectObviouslyUnsafeExternalUrl(value: string): URL {
  const url = parseHttpUrl(value);
  if (!url) throw new UnsafeExternalUrlError('Only absolute HTTP(S) URLs without credentials are allowed');
  const hostname = normalizedHostname(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new UnsafeExternalUrlError(`Blocked local hostname: ${hostname}`);
  }
  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new UnsafeExternalUrlError(`Blocked non-public IP address: ${hostname}`);
  }
  return url;
}

async function defaultResolveHost(hostname: string): Promise<readonly ResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results
    .filter((result): result is ResolvedAddress => result.family === 4 || result.family === 6)
    .map(result => ({ address: result.address, family: result.family }));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('External request aborted');
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function resolveAndValidate(
  url: URL,
  resolveHost: ResolveHost,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  rejectObviouslyUnsafeExternalUrl(url.href);
  const hostname = normalizedHostname(url.hostname);
  const addresses = await withAbort(Promise.resolve(resolveHost(hostname)), signal);
  if (addresses.length === 0) throw new UnsafeExternalUrlError(`No DNS address found for ${hostname}`);
  for (const result of addresses) {
    if ((result.family !== 4 && result.family !== 6) || !isPublicIpAddress(result.address)) {
      throw new UnsafeExternalUrlError(`Blocked non-public DNS result for ${hostname}: ${result.address}`);
    }
  }
  return addresses[0]!;
}

interface OneResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

async function requestPinned(
  url: URL,
  destination: ResolvedAddress,
  signal: AbortSignal,
  maxBytes: number,
  userAgent: string,
): Promise<OneResponse> {
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, destination.address, destination.family);
  };
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  return await new Promise<OneResponse>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = request({
      protocol: url.protocol,
      hostname: normalizedHostname(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity',
      },
      lookup: pinnedLookup,
      signal,
    }, response => {
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        finishReject(new Error(`External response exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > maxBytes) {
          response.destroy();
          finishReject(new Error(`External response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', finishReject);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', finishReject);
    req.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch untrusted job HTML without allowing the server to reach local networks.
 * Every redirect is resolved again, and the socket is pinned to the validated
 * address so a second DNS answer cannot rebind the connection.
 */
export async function fetchExternalText(
  value: string,
  options: SafeExternalFetchOptions = {},
): Promise<ExternalTextResponse> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = combinedAbortSignal(options.signal, timeoutSignal);
  let url = rejectObviouslyUnsafeExternalUrl(value);

  for (let redirectCount = 0; ; redirectCount += 1) {
    try {
      const destination = await resolveAndValidate(url, resolveHost, signal);
      const response = await requestPinned(
        url,
        destination,
        signal,
        maxBytes,
        options.userAgent ?? 'JobBot/0.2 (personal job-search assistant)',
      );
      if (REDIRECT_STATUSES.has(response.status) && response.headers.location) {
        if (redirectCount >= maxRedirects) throw new Error(`External request exceeded ${maxRedirects} redirects`);
        url = rejectObviouslyUnsafeExternalUrl(new URL(response.headers.location, url).href);
        continue;
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        url: url.href,
        headers: response.headers,
        text: response.body.toString('utf8'),
      };
    } catch (error) {
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new Error(`External request timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw error;
    }
  }
}

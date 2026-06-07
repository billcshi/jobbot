/** Supported ATS types. */
export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'linkedin'
  | 'generic';

/**
 * ATS detection rules.  Order matters — first match wins.
 * Each rule has a list of hostname patterns and an optional path prefix.
 */
const RULES: { type: AtsType; hosts: string[]; pathPrefix?: string }[] = [
  {
    type: 'greenhouse',
    hosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  },
  {
    type: 'lever',
    hosts: ['jobs.lever.co'],
  },
  {
    type: 'ashby',
    hosts: ['jobs.ashbyhq.com'],
  },
  {
    type: 'workday',
    hosts: [], // detected by hostname containing 'myworkdayjobs'
    pathPrefix: undefined,
  },
  {
    type: 'linkedin',
    hosts: ['linkedin.com', 'www.linkedin.com'],
    pathPrefix: '/jobs',
  },
];

/**
 * Detect the ATS type from a job posting URL.
 *
 * Detection is hostname-based with an optional path prefix.
 * Returns `'generic'` when no rule matches.
 */
export function detectAts(url: string): AtsType {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'generic';
  }

  const host = parsed.hostname.toLowerCase();

  // Special case: myworkdayjobs.com subdomain
  if (host.includes('myworkdayjobs')) {
    return 'workday';
  }

  for (const rule of RULES) {
    const hostMatch = rule.hosts.some((h) => host === h || host.endsWith('.' + h));
    if (!hostMatch) continue;

    if (rule.pathPrefix) {
      if (parsed.pathname.toLowerCase().startsWith(rule.pathPrefix)) {
        return rule.type;
      }
      // For LinkedIn, *only* match /jobs paths.
      // For other rules without pathPrefix, the host is enough.
    } else {
      return rule.type;
    }
  }

  return 'generic';
}

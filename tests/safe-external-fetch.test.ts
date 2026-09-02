import { describe, expect, it } from 'vitest';
import {
  fetchExternalText,
  isPublicIpAddress,
  rejectObviouslyUnsafeExternalUrl,
} from '../src/utils/safe-external-fetch.js';

describe('safe external job fetch boundary', () => {
  it('rejects non-public IPv4 and IPv6 ranges while allowing public addresses', () => {
    for (const address of [
      '0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '64:ff9b:1::1', 'fc00::1', 'fe80::1',
      'fec0::1', 'feff::1', 'ff02::1', '2001:db8::1', '2001:20::1',
      '2001:2::1', '3fff::1', '5f00::1', '400::1', '1000::1',
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects obvious local and cloud-metadata URLs during ingestion', () => {
    expect(() => rejectObviouslyUnsafeExternalUrl('http://127.0.0.1:3102/login'))
      .toThrow('Blocked non-public IP address');
    expect(() => rejectObviouslyUnsafeExternalUrl('http://169.254.169.254/latest/meta-data/'))
      .toThrow('Blocked non-public IP address');
    expect(() => rejectObviouslyUnsafeExternalUrl('http://[::1]/admin'))
      .toThrow('Blocked non-public IP address');
    expect(() => rejectObviouslyUnsafeExternalUrl('http://localhost/admin'))
      .toThrow('Blocked local hostname');
  });

  it('rejects private and mixed DNS answers before opening a connection', async () => {
    await expect(fetchExternalText('https://jobs.example.com/role', {
      resolveHost: async () => [{ address: '10.0.0.8', family: 4 }],
    })).rejects.toThrow('Blocked non-public DNS result');

    await expect(fetchExternalText('https://jobs.example.com/role', {
      resolveHost: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })).rejects.toThrow('Blocked non-public DNS result');

    await expect(fetchExternalText('https://jobs.example.com/role', {
      resolveHost: async () => [{ address: '2001:2::1', family: 6 }],
    })).rejects.toThrow('Blocked non-public DNS result');
  });

  it('applies the hard deadline while DNS resolution is pending', async () => {
    await expect(fetchExternalText('https://jobs.example.com/role', {
      timeoutMs: 5,
      resolveHost: async () => await new Promise(() => undefined),
    })).rejects.toThrow('External request timed out after 5ms');
  });
});

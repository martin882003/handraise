import { networkInterfaces } from 'node:os';

function normalizedListener(listener) {
  if (!listener || typeof listener === 'string') return { address: String(listener || ''), port: null, family: null };
  return {
    address: String(listener.address || ''),
    port: Number(listener.port) || null,
    family: listener.family || null,
  };
}

export function normalizedPublicOrigin(value, { requireHttps = false } = {}) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (requireHttps && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function privateAddressKind(address) {
  const value = String(address || '').toLowerCase();
  const octets = value.split('.').map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) return 'lan';
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return 'tailnet';
    return null;
  }
  if (/^f[cd][0-9a-f]*:/i.test(value)) return 'private-ipv6';
  return null;
}

const wildcardListener = (address) => ['0.0.0.0', '::', '::0'].includes(String(address || '').toLowerCase());
const sameAddress = (left, right) => String(left || '').replace(/^::ffff:/i, '') === String(right || '').replace(/^::ffff:/i, '');
const urlHost = (address) => String(address).includes(':') ? `[${address}]` : String(address);

export function remoteAccessOptions({
  listener,
  publicUrl = null,
  interfaces = networkInterfaces(),
} = {}) {
  const bound = normalizedListener(listener);
  const port = bound.port;
  const addresses = Object.entries(interfaces || {}).flatMap(([interfaceName, records]) => (
    (Array.isArray(records) ? records : []).flatMap((record) => {
      if (!record || record.internal) return [];
      const kind = privateAddressKind(record.address);
      if (!kind || !port) return [];
      const address = String(record.address);
      const reachable = wildcardListener(bound.address) || sameAddress(bound.address, address);
      return [{
        interface: interfaceName,
        address,
        family: record.family,
        kind,
        reachable,
        url: `http://${urlHost(address)}:${port}`,
      }];
    })
  )).sort((left, right) => {
    const rank = { lan: 0, tailnet: 1, 'private-ipv6': 2 };
    return rank[left.kind] - rank[right.kind] || left.interface.localeCompare(right.interface) || left.address.localeCompare(right.address);
  });
  const selected = addresses.find((candidate) => candidate.reachable) || addresses[0] || null;
  const configuredPublicOrigin = normalizedPublicOrigin(publicUrl);
  const securePublicOrigin = normalizedPublicOrigin(publicUrl, { requireHttps: true });
  const privateRestartCommand = port ? `handraise serve --host 0.0.0.0 --port ${port}` : 'handraise serve --host 0.0.0.0';
  const privateServiceCommand = port ? `handraise service install --host 0.0.0.0 --port ${port}` : 'handraise service install --host 0.0.0.0';
  const internetCommand = port
    ? `handraise serve --port ${port} --public-url https://your-handraise.example`
    : 'handraise serve --public-url https://your-handraise.example';

  return {
    listener: {
      address: bound.address,
      port,
      family: bound.family,
      loopbackOnly: ['127.0.0.1', '::1'].includes(bound.address),
      wildcard: wildcardListener(bound.address),
    },
    privateNetwork: {
      available: addresses.length > 0,
      ready: addresses.some((candidate) => candidate.reachable),
      addresses,
      selectedAddress: selected?.address || null,
      url: selected?.url || null,
      restartCommand: privateRestartCommand,
      serviceCommand: privateServiceCommand,
      guidance: !addresses.length
        ? 'No private LAN or tailnet address was detected on the server host.'
        : addresses.some((candidate) => candidate.reachable)
          ? 'Use this only on a trusted private network. The remote client still needs the one-time pairing credential.'
          : 'The server is currently listening only on loopback. Restart it on 0.0.0.0 before advertising this private address.',
    },
    internet: {
      configured: Boolean(configuredPublicOrigin),
      ready: Boolean(securePublicOrigin),
      url: securePublicOrigin,
      configuredUrl: configuredPublicOrigin,
      command: internetCommand,
      guidance: securePublicOrigin
        ? 'The configured HTTPS origin will be encoded in the one-time QR. Keep the tunnel or reverse proxy running while the client connects.'
        : configuredPublicOrigin
          ? 'The configured public origin is not HTTPS. Internet pairing requires HTTPS.'
          : 'Create an HTTPS tunnel or reverse proxy to this server, then enter that public origin. Handraise does not publish the server by itself.',
    },
  };
}

export function pairingOriginFor(options, {
  mode = 'current',
  address = null,
  publicUrl = null,
  currentOrigin = null,
} = {}) {
  if (mode === 'private') {
    const candidates = options?.privateNetwork?.addresses || [];
    const candidate = address
      ? candidates.find((item) => item.address === address)
      : candidates.find((item) => item.reachable) || candidates[0];
    if (!candidate) throw new Error('no private LAN or tailnet address is available on the server host');
    if (!candidate.reachable) {
      throw new Error(`the server is not reachable at ${candidate.url}; restart it with: ${options.privateNetwork.restartCommand}`);
    }
    return candidate.url;
  }
  if (mode === 'internet') {
    const origin = normalizedPublicOrigin(publicUrl || options?.internet?.url, { requireHttps: true });
    if (!origin) throw new Error('internet pairing requires the HTTPS public URL that currently forwards to this Handraise server');
    return origin;
  }
  if (mode !== 'current') throw new Error('pairing mode must be private, internet or current');
  const origin = normalizedPublicOrigin(currentOrigin);
  if (!origin) throw new Error('the current client origin cannot be used for pairing');
  return origin;
}

export const LOCAL_CLIENT_ID = 'server-host';

const LOCAL_CLIENT = Object.freeze({
  id: LOCAL_CLIENT_ID,
  name: 'Server host',
  kind: 'implicit-local',
  implicit: true,
  revocable: false,
});

function validPort(value) {
  if (value === undefined) return true;
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65_535;
}

// Keep this deliberately narrower than URL parsing. WHATWG URLs accept legacy
// IPv4 spellings such as 127.1 and integer addresses; those are not part of the
// product trust boundary described by AUTH-12.
export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || host.includes(',') || /\s/.test(host)) return false;

  let match = /^(localhost|127\.0\.0\.1)(?::([^:]+))?$/.exec(host);
  if (match) return validPort(match[2]);

  if (host === '::1') return true;
  match = /^\[::1\](?::([^:]+))?$/.exec(host);
  return Boolean(match && validPort(match[1]));
}

export function isLoopbackPeer(value) {
  const address = String(value || '').trim().toLowerCase();
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

export function implicitLocalClient(request) {
  if (!isLoopbackPeer(request?.socket?.remoteAddress)) return null;
  if (!isLoopbackHost(request?.headers?.host)) return null;
  return LOCAL_CLIENT;
}

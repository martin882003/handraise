---
slug: honest-client-states
component: client-experience
state: done
impact: alto
complexity: media
---

# honest-client-states — Make client availability and authentication unambiguous

**Componente:** client-experience

## Observable outcome

Every Handraise client clearly distinguishes loading, offline server, implicit server-host access, unpaired device, expired session and authenticated operation, while offering the correct recovery or logout action in a consistent visual theme.

## Confirmed context

The current PWA shell can conflate a network failure with pairing and does not expose the complete authenticated-client lifecycle. A browser opened directly through a loopback origin is inside the server-host trust boundary and must enter without pairing; LAN, tailnet and tunneled clients still pair normally. The API already supports logout, while service-worker cache upgrades, offline action disabling, recovery copy and pre-authentication theme initialization remain incomplete. Client means browser/PWA and server means the local `handraise serve` process.

## ▶ Handoff

Model client state explicitly before polishing individual screens. Implement implicit local trust only when both the socket peer and HTTP host are loopback, never through forwarding headers. Ensure cached content never impersonates a reachable server, disable server-backed actions offline, and preserve theme initialization across every surface. Coordinate readiness/auth semantics with Local Platform & Trust and avoid interpreting generic fetch failure as a 401.

## Checklist

- [x] 1. Define a single client-state model for loading, offline, unpaired, expired and authenticated states.
- [x] 2. Separate network failures, readiness failures and unauthenticated responses in the API client.
- [x] 3. Authenticate direct loopback access as an implicit server-host client without creating a paired-device record.
- [x] 4. Add correct pairing and recovery guidance for first, additional and inaccessible remote clients.
- [x] 5. Expose logout where meaningful and handle session expiry without losing the user's navigation context.
- [x] 6. Initialize theme and color mode before rendering every authentication or offline surface.
- [x] 7. Make the service worker show an explicit offline shell, disable mutations and upgrade caches safely.
- [x] 8. Add UI and browser tests covering loopback trust, spoofed hosts, forwarded requests and the remote client lifecycle.
- [x] 9. Add an explicit private-network versus Internet pairing assistant that advertises only reachable server-derived or confirmed HTTPS origins.
- [x] 10. Create, observe and stop a temporary Cloudflare Quick Tunnel from the Internet pairing flow without accepting shell input or hiding its public, third-party and temporary nature.
- [x] 11. Keep remote clients live through authenticated polling when the selected tunnel cannot transport SSE, and verify the tunnel-to-QR lifecycle end to end.

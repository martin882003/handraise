---
slug: client-experience
title: Client Experience
state: active
order: 4
since: 2026-08-03
---
## Scope

Make the Handraise browser client and installable PWA clear, fast and trustworthy across desktop and mobile. Own information architecture, interaction design, responsive layouts, accessibility, visual language, terminal and permission presentation, proposal review, and honest loading, offline, authentication, error and recovery states.

## Limits

Does not implement server-side lifecycle, repository mutation, agent adapters or authentication policy. It must not hide missing capabilities, represent network failure as an unpaired client, or invent optimistic success for operations the server has not confirmed.

## Agent guidance

Start from the user's operational decision: what needs attention, what is safe to do, and what will happen next. Preserve context across navigation, use progressive disclosure for technical detail, support keyboard and touch interaction, and test narrow screens and failure states. Coordinate API contract changes with the owning backend component before relying on them.

## Territory

`ui/`, including `ui/src/main.tsx`, `ui/src/styles.css`, source PWA assets and service-worker behavior. `dist/ui/` is generated output and must only change through the build. Product copy and browser-facing behavior across all Handraise surfaces belong here.

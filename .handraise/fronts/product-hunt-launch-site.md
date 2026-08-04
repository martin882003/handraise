---
slug: product-hunt-launch-site
component: client-experience
state: active
impact: alto
complexity: media
---

# product-hunt-launch-site — Explain Handraise clearly at launch

**Componente:** client-experience

## Observable outcome

A visitor arriving from Product Hunt can understand Handraise's differentiated product thesis, see the complete Understand → Design → Run loop, verify its local-first trust model, and reach a working install or launch action from desktop or mobile.

## Confirmed context

The canonical promise is “Understand the system. Design the work. Run the agents.” The launch page must lead with work modeling—not generic multi-agent parallelism—and describe only capabilities represented by the current product contracts. Its motion language may be cinematic and reactive, while remaining fast, readable, progressively enhanced and respectful of reduced-motion preferences.

## ▶ Handoff

Ship a dependency-free static landing under `site/`, preserve the product's dark local-control visual language, and validate the actual browser result at launch breakpoints. Keep repository analysis, planning truth states, human acceptance, agent execution and local-first boundaries explicit.

## Checklist

- [x] 1. Establish truthful launch positioning, canonical slogan and primary conversion paths.
- [x] 2. Build the responsive static landing and code-native product preview under `site/`.
- [x] 3. Add purposeful reactive and scroll-driven motion with a complete reduced-motion fallback.
- [x] 4. Verify semantic structure, keyboard interactions, focus states, copy action and internal links.
- [x] 5. Validate desktop and mobile rendering in a real browser with no horizontal overflow.
- [ ] 6. Verify launch URLs, social metadata and a production-style static-server smoke test.

## Launch gate

The static-server smoke, GitHub URL, official pixel-hand logo and 1200×630 social preview are verified. The standalone site was published from `martin882003/handraise-site@08484c5` to `https://handraise.pages.dev/`; production HTML, CSP, JavaScript, logo and social image all returned HTTP 200 and the deployed page was checked in real Chrome. `https://www.producthunt.com/posts/handraise` remains centralized but cannot be marked verified until the Product Hunt listing is publicly reachable.

(() => {
  "use strict";

  document.documentElement.classList.add("js");

  const PRODUCT_HUNT_URL = "https://www.producthunt.com/posts/handraise";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  document.querySelectorAll("[data-product-hunt]").forEach((link) => {
    link.href = PRODUCT_HUNT_URL;
  });

  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());

  const header = document.querySelector("[data-header]");
  const kinetic = document.querySelector("[data-kinetic]");
  const chapterLinks = [...document.querySelectorAll("[data-chapter]")];
  const chapterTargets = chapterLinks
    .map((link) => ({ link, target: document.getElementById(link.dataset.chapter) }))
    .filter(({ target }) => target);

  let scrollFrame = 0;
  const updateScrollEffects = () => {
    scrollFrame = 0;
    const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const pageProgress = Math.min(1, Math.max(0, window.scrollY / scrollable));
    document.body.style.setProperty("--page-progress", pageProgress.toFixed(4));
    header?.classList.toggle("scrolled", window.scrollY > 18);

    if (kinetic && !reducedMotion.matches) {
      const rect = kinetic.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)));
      kinetic.style.setProperty("--kinetic-progress", progress.toFixed(4));
    }

    if (chapterTargets.length) {
      const marker = window.scrollY + window.innerHeight * 0.38;
      let active = chapterTargets[0];
      chapterTargets.forEach((chapter) => {
        if (chapter.target.offsetTop <= marker) active = chapter;
      });
      chapterLinks.forEach((link) => link.classList.toggle("active", link === active.link));
    }
  };

  const requestScrollUpdate = () => {
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updateScrollEffects);
  };
  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  window.addEventListener("resize", requestScrollUpdate, { passive: true });
  updateScrollEffects();

  const navToggle = document.querySelector("[data-nav-toggle]");
  const navLinks = document.querySelector("[data-nav-links]");
  const closeNav = () => {
    if (!navToggle || !navLinks) return;
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open navigation");
    navLinks.classList.remove("open");
  };
  navToggle?.addEventListener("click", () => {
    const willOpen = navToggle.getAttribute("aria-expanded") !== "true";
    navToggle.setAttribute("aria-expanded", String(willOpen));
    navToggle.setAttribute("aria-label", willOpen ? "Close navigation" : "Open navigation");
    navLinks?.classList.toggle("open", willOpen);
  });
  navLinks?.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeNav();
  });
  document.addEventListener("click", (event) => {
    if (!navLinks?.classList.contains("open")) return;
    if (!event.target.closest(".nav")) closeNav();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navLinks?.classList.contains("open")) {
      closeNav();
      navToggle?.focus();
    }
  });

  const revealItems = [...document.querySelectorAll(".reveal")];
  document.querySelectorAll(".problem-grid, .capability-grid").forEach((group) => {
    [...group.querySelectorAll(":scope > .reveal")].forEach((item, index) => {
      item.dataset.revealDelay = String((index % 3) + 1);
    });
  });

  if ("IntersectionObserver" in window && !reducedMotion.matches) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("visible"));
  }

  const revealItemsInViewport = () => {
    revealItems.forEach((item) => {
      if (item.classList.contains("visible")) return;
      const rect = item.getBoundingClientRect();
      if (rect.bottom >= 0 && rect.top <= window.innerHeight * 1.08) item.classList.add("visible");
    });
  };
  window.addEventListener("scroll", revealItemsInViewport, { passive: true });
  window.addEventListener("hashchange", revealItemsInViewport);
  window.addEventListener("load", revealItemsInViewport, { once: true });
  window.setTimeout(revealItemsInViewport, 80);
  window.setTimeout(revealItemsInViewport, 700);

  const tabs = [...document.querySelectorAll("[data-demo-tab]")];
  const panels = [...document.querySelectorAll("[data-demo-panel]")];
  const activateTab = (tab, shouldFocus = false) => {
    tabs.forEach((candidate) => {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.demoPanel !== tab.dataset.demoTab;
    });
    if (shouldFocus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(tabs[nextIndex], true);
    });
  });

  const copyButton = document.querySelector("[data-copy-install]");
  const installCode = document.querySelector("[data-install-code]");
  copyButton?.addEventListener("click", async () => {
    const commands = (installCode?.textContent || "")
      .split("\n")
      .map((line) => line.replace(/^\$\s*/, ""))
      .join("\n")
      .trim();
    if (!commands) return;

    try {
      await navigator.clipboard.writeText(commands);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = commands;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    const label = copyButton.querySelector("span");
    if (!label) return;
    label.textContent = "Copied";
    window.setTimeout(() => { label.textContent = "Copy"; }, 1700);
  });

  document.querySelectorAll(".problem-card, .truth-list article, .capability-grid article").forEach((card) => {
    card.dataset.spotlight = "";
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
      card.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
    }, { passive: true });
  });

  const hero = document.querySelector(".hero");
  const product = document.querySelector(".hero-product");
  const resetProductTilt = () => {
    if (!product) return;
    product.style.removeProperty("--lift-x");
    product.style.removeProperty("--lift-y");
    product.style.removeProperty("--tilt-x");
    product.style.removeProperty("--tilt-y");
  };

  if (hero && product && finePointer.matches && !reducedMotion.matches) {
    hero.addEventListener("pointermove", (event) => {
      const heroRect = hero.getBoundingClientRect();
      const heroX = ((event.clientX - heroRect.left) / heroRect.width) * 100;
      const heroY = ((event.clientY - heroRect.top) / heroRect.height) * 100;
      hero.style.setProperty("--hero-x", `${heroX.toFixed(2)}%`);
      hero.style.setProperty("--hero-y", `${heroY.toFixed(2)}%`);

      const rect = product.getBoundingClientRect();
      const x = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
      const y = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
      product.style.setProperty("--lift-x", `${(x * 5).toFixed(2)}px`);
      product.style.setProperty("--lift-y", `${(y * 4).toFixed(2)}px`);
      product.style.setProperty("--tilt-y", `${(-7 + x * 3.2).toFixed(2)}deg`);
      product.style.setProperty("--tilt-x", `${(2 - y * 2.2).toFixed(2)}deg`);
    }, { passive: true });
    hero.addEventListener("pointerleave", resetProductTilt, { passive: true });
  }

  class ParticleField {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d", { alpha: true });
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.frame = 0;
      this.visible = true;
      this.pointer = { x: 0, y: 0, active: false };
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.intersectionObserver = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        if (this.visible) this.start();
        else this.stop();
      }, { rootMargin: "120px" });

      this.resizeObserver.observe(canvas);
      this.intersectionObserver.observe(canvas);
      hero?.addEventListener("pointermove", (event) => this.updatePointer(event), { passive: true });
      hero?.addEventListener("pointerleave", () => { this.pointer.active = false; }, { passive: true });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.stop();
        else if (this.visible) this.start();
      });
      reducedMotion.addEventListener?.("change", () => {
        this.stop();
        this.draw(0);
        if (!reducedMotion.matches && this.visible) this.start();
      });
      this.resize();
      this.draw(0);
      if (!reducedMotion.matches) this.start();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, Math.round(rect.width));
      this.height = Math.max(1, Math.round(rect.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.draw(performance.now());
    }

    updatePointer(event) {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = event.clientX - rect.left;
      this.pointer.y = event.clientY - rect.top;
      this.pointer.active = true;
    }

    start() {
      if (this.frame || reducedMotion.matches || document.hidden) return;
      this.frame = window.requestAnimationFrame((time) => this.tick(time));
    }

    stop() {
      if (!this.frame) return;
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }

    tick(time) {
      this.frame = 0;
      this.draw(time);
      if (this.visible && !reducedMotion.matches && !document.hidden) this.start();
    }

    draw(time) {
      const ctx = this.context;
      if (!ctx || !this.width || !this.height) return;
      ctx.clearRect(0, 0, this.width, this.height);

      const compact = this.width < 760;
      const step = compact ? 21 : 18;
      const phase = time * 0.00055;
      const centerX = this.width * (0.68 + Math.sin(phase * 0.72) * 0.035);
      const centerY = this.height * (0.49 + Math.cos(phase * 0.58) * 0.04);
      const radiusX = this.width * (compact ? 0.48 : 0.34);
      const radiusY = this.height * 0.42;

      for (let y = step * 0.5; y < this.height; y += step) {
        for (let x = step * 0.5; x < this.width; x += step) {
          const nx = (x - centerX) / radiusX;
          const ny = (y - centerY) / radiusY;
          const distance = Math.sqrt(nx * nx + ny * ny);
          const wave = Math.sin(x * 0.018 + phase * 3.4) + Math.cos(y * 0.021 - phase * 2.7) + Math.sin((x + y) * 0.009 - phase * 1.8);
          const envelope = Math.max(0, 1 - distance * 0.79);
          const contour = Math.max(0, 1 - Math.abs(distance - (0.55 + wave * 0.055)) * 2.8);

          let pointerForce = 0;
          if (this.pointer.active && !reducedMotion.matches) {
            const pointerDistance = Math.hypot(x - this.pointer.x, y - this.pointer.y);
            pointerForce = Math.max(0, 1 - pointerDistance / 190);
          }

          const energy = envelope * 0.66 + contour * 0.58 + pointerForce * 0.8;
          if (energy < 0.12) continue;
          const size = Math.min(step * 0.52, 1.1 + energy * 5.4 + Math.max(0, wave) * 0.48);
          const offset = pointerForce * 7;
          const angle = Math.atan2(y - this.pointer.y, x - this.pointer.x);
          const drawX = x + Math.cos(angle) * offset;
          const drawY = y + Math.sin(angle) * offset;

          if (pointerForce > 0.36) ctx.fillStyle = `rgba(255, 177, 142, ${Math.min(0.72, 0.2 + energy * 0.25)})`;
          else if (wave > 1.25 && distance < 0.9) ctx.fillStyle = `rgba(104, 214, 173, ${Math.min(0.42, 0.08 + energy * 0.16)})`;
          else ctx.fillStyle = `rgba(255, 122, 61, ${Math.min(0.47, 0.05 + energy * 0.17)})`;

          ctx.fillRect(drawX - size * 0.5, drawY - size * 0.5, size, size);
        }
      }
    }
  }

  const particleCanvas = document.querySelector("[data-particle-field]");
  if (particleCanvas && "ResizeObserver" in window && "IntersectionObserver" in window) {
    new ParticleField(particleCanvas);
  }
})();

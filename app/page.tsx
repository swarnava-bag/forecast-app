"use client";
import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

import HeroSection from "@/app/components/landing/HeroSection";
import NetworkSection from "@/app/components/landing/NetworkSection";
import RoadmapSection from "@/app/components/landing/RoadmapSection";
import LoginCard from "@/app/components/landing/LoginCard";

gsap.registerPlugin(ScrollTrigger);

/* ── Grain / noise overlay ──────────────────────────────────────────────── */

function GrainOverlay() {
  return <div className="grain-overlay" aria-hidden="true" />;
}

/* ── Gradient orbs ──────────────────────────────────────────────────────── */

function GradientOrbs() {
  return (
    <>
      <div className="gradient-orb gradient-orb-1" aria-hidden="true" />
      <div className="gradient-orb gradient-orb-2" aria-hidden="true" />
    </>
  );
}

/* ── Scroll progress bar ────────────────────────────────────────────────── */

function ScrollProgress() {
  return <div className="scroll-progress-bar" />;
}

/* ── Particle dust field — floating dots that drift with scroll ────────── */

function ParticleField() {
  return (
    <div className="particle-field" aria-hidden="true">
      {Array.from({ length: 30 }).map((_, i) => (
        <span key={i} className={`particle particle-${i % 6}`} style={{
          left: `${5 + (i * 37 + i * i * 7) % 90}%`,
          top: `${(i * 53 + i * i * 3) % 100}%`,
          animationDelay: `${(i * 0.7) % 8}s`,
          animationDuration: `${12 + (i % 5) * 4}s`,
        }} />
      ))}
    </div>
  );
}

/* ── Aurora mesh — rotating conic gradients below login card ──────────── */

function AuroraMesh() {
  return (
    <div className="aurora-mesh" aria-hidden="true">
      {/* Rotating gradient discs — each spins at different speed */}
      <div className="aurora-disc aurora-disc-1" />
      <div className="aurora-disc aurora-disc-2" />
      <div className="aurora-disc aurora-disc-3" />

      {/* Morphing accent ring */}
      <div className="aurora-ring" />

      {/* Scroll progress */}
      <div className="aurora-progress">
        <div className="aurora-progress-label aurora-label-active">01</div>
        <div className="aurora-progress-track">
          <div className="aurora-progress-fill" />
        </div>
        <div className="aurora-progress-label">03</div>
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function AtlasLanding() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [checkingAuth, setCheckingAuth] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Check if already logged in
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace("/dashboard");
      } else {
        setCheckingAuth(false);
      }
    });
  }, [router]);

  // Load theme preference
  useEffect(() => {
    const savedTheme = localStorage.getItem("atlas_login_theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
    }
  }, []);

  // ── GSAP Animations ──────────────────────────────────────────────────
  useGSAP(() => {
    if (checkingAuth) return;

    const mm = gsap.matchMedia();

    // ── Scroll progress bar ──────────────────────────────────────────
    gsap.to(".scroll-progress-bar", {
      scaleX: 1,
      ease: "none",
      scrollTrigger: {
        trigger: containerRef.current,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.3,
      },
    });

    // ── Desktop animations ──────────────────────────────────────────
    mm.add("(min-width: 1024px)", () => {

      // ═══ HERO ENTRANCE TIMELINE ═══
      const heroTl = gsap.timeline({ delay: 0.35, defaults: { ease: "power3.out" } });

      // Background wordmark — subtle fade-in, stays very faint
      heroTl.fromTo(".hero-bg-wordmark",
        { yPercent: 15, opacity: 0, scale: 0.92 },
        { yPercent: 0, opacity: 0.04, scale: 1, duration: 1.6, ease: "expo.out" },
        0
      );

      // Eyebrow line draws
      heroTl.fromTo(".hero-eyebrow-line",
        { scaleX: 0, transformOrigin: "left center" },
        { scaleX: 1, duration: 0.9, ease: "power3.inOut" },
        0.15
      );
      heroTl.fromTo(".hero-eyebrow .atlas-eyebrow",
        { x: -24, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.7 },
        0.5
      );

      // Headline — stagger word reveal with overflow mask + blur
      heroTl.fromTo(".hero-headline .split-word",
        { yPercent: 120, filter: "blur(6px)" },
        { yPercent: 0, filter: "blur(0px)", duration: 1, ease: "power4.out", stagger: 0.04 },
        0.45
      );

      // Lede paragraph
      heroTl.fromTo(".hero-lede",
        { y: 24, opacity: 0, filter: "blur(4px)" },
        { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.8 },
        "-=0.5"
      );

      // Horizontal divider draws in
      heroTl.fromTo(".hero-divider",
        { scaleX: 0, transformOrigin: "left center" },
        { scaleX: 1, duration: 0.7, ease: "power3.inOut" },
        "-=0.4"
      );

      // Micro stats stagger
      heroTl.fromTo(".hero-micro-stat, .hero-micro-divider",
        { y: 12, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.5, stagger: 0.06 },
        "-=0.25"
      );

      // Counter animation for micro-stat numbers
      heroTl.add(() => {
        document.querySelectorAll<HTMLElement>(".hero-micro-num[data-count]").forEach((el) => {
          const target = parseInt(el.dataset.count || "0", 10);
          const suffix = el.dataset.suffix || "";
          const obj = { val: 0 };
          gsap.to(obj, {
            val: target,
            duration: 1.6,
            ease: "power2.out",
            onUpdate() {
              el.textContent = Math.round(obj.val) + suffix;
            },
          });
        });
      }, "-=0.3");

      // Login card — cinematic entrance
      heroTl.fromTo(".login-card-anim",
        { y: 50, opacity: 0, scale: 0.98, filter: "blur(8px)" },
        { y: 0, opacity: 1, scale: 1, filter: "blur(0px)", duration: 1.1 },
        0.55
      );

      // Card-behind subtle rotation
      heroTl.fromTo(".atlas-card-behind",
        { opacity: 0, rotate: 0 },
        { opacity: 0.12, rotate: 2.5, duration: 1.2, ease: "power2.out" },
        0.7
      );

      // Scroll indicator
      heroTl.fromTo(".scroll-indicator",
        { opacity: 0 },
        { opacity: 1, duration: 0.5 },
        "-=0.3"
      );

      // Scroll indicator thumb loop
      gsap.to(".scroll-indicator-thumb", {
        y: 16,
        duration: 1.6,
        ease: "power1.inOut",
        repeat: -1,
        yoyo: true,
      });

      // ═══ HERO SECTION EXIT — fades as you scroll past ═══
      gsap.to("#hero .hero-content", {
        opacity: 0,
        y: -30,
        ease: "none",
        scrollTrigger: {
          trigger: "#hero",
          start: "60% top",
          end: "bottom top",
          scrub: 1,
        },
      });

      // Hero wordmark parallax on scroll
      gsap.to(".hero-bg-wordmark", {
        yPercent: -30,
        opacity: 0,
        ease: "none",
        scrollTrigger: {
          trigger: "#hero",
          start: "top top",
          end: "bottom top",
          scrub: 1.5,
        },
      });

      // ═══ PARTICLE FIELD PARALLAX ═══
      gsap.utils.toArray<HTMLElement>(".particle").forEach((p, i) => {
        gsap.to(p, {
          y: -(100 + (i % 5) * 80),
          ease: "none",
          scrollTrigger: {
            trigger: containerRef.current,
            start: "top top",
            end: "bottom bottom",
            scrub: 1 + (i % 3),
          },
        });
      });

      // ═══ GRADIENT ORBS PARALLAX ═══
      gsap.to(".gradient-orb-1", {
        yPercent: -50,
        ease: "none",
        scrollTrigger: { trigger: containerRef.current, start: "top top", end: "bottom bottom", scrub: 2 },
      });
      gsap.to(".gradient-orb-2", {
        yPercent: -30,
        xPercent: 8,
        ease: "none",
        scrollTrigger: { trigger: containerRef.current, start: "top top", end: "bottom bottom", scrub: 3 },
      });

      // ═══ NETWORK SECTION ═══
      // Section entrance
      gsap.fromTo("#network .network-content",
        { opacity: 0, y: 60 },
        {
          opacity: 1, y: 0, duration: 1.2, ease: "power3.out",
          scrollTrigger: { trigger: "#network", start: "top 75%", toggleActions: "play none none none" },
        }
      );

      // Eyebrow line draws in
      gsap.fromTo("#network .section-eyebrow-line",
        { scaleX: 0, transformOrigin: "left center" },
        {
          scaleX: 1, duration: 0.8, ease: "power3.inOut",
          scrollTrigger: { trigger: "#network", start: "top 68%", toggleActions: "play none none none" },
        }
      );
      gsap.fromTo("#network .atlas-eyebrow",
        { x: -16, opacity: 0 },
        {
          x: 0, opacity: 1, duration: 0.6,
          scrollTrigger: { trigger: "#network", start: "top 66%", toggleActions: "play none none none" },
        }
      );

      // Section title — cinematic word reveal
      gsap.fromTo("#network .split-word",
        { yPercent: 110, opacity: 0 },
        {
          yPercent: 0, opacity: 1, duration: 0.9, ease: "power4.out", stagger: 0.06,
          scrollTrigger: { trigger: "#network", start: "top 70%", toggleActions: "play none none none" },
        }
      );

      // Section number — parallax drift
      gsap.fromTo(".network-section-num",
        { yPercent: 40, opacity: 0, scale: 0.85 },
        {
          yPercent: 0, opacity: 1, scale: 1, duration: 1.2, ease: "expo.out",
          scrollTrigger: { trigger: "#network", start: "top 75%", toggleActions: "play none none none" },
        }
      );
      // Continuous parallax on section number
      gsap.to(".network-section-num", {
        yPercent: -40,
        ease: "none",
        scrollTrigger: { trigger: "#network", start: "top bottom", end: "bottom top", scrub: 2 },
      });

      // SVG edge draw with scrub
      const edges = gsap.utils.toArray<SVGPathElement>(".network-edge");
      edges.forEach((edge) => {
        const length = edge.getTotalLength();
        gsap.set(edge, { strokeDasharray: length, strokeDashoffset: length });
        gsap.to(edge, {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: { trigger: "#network", start: "top 60%", end: "40% 40%", scrub: 1.2 },
        });
      });

      // Glow edges
      const glowEdges = gsap.utils.toArray<SVGPathElement>(".network-edge-glow");
      glowEdges.forEach((edge) => {
        const length = edge.getTotalLength();
        gsap.set(edge, { strokeDasharray: length, strokeDashoffset: length });
        gsap.to(edge, {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: { trigger: "#network", start: "top 55%", end: "40% 35%", scrub: 1.5 },
        });
      });

      // Nodes pop with pulse ripple
      const nodesTl = gsap.timeline({
        scrollTrigger: { trigger: "#network", start: "20% 60%", toggleActions: "play none none none" },
      });
      nodesTl.fromTo(".network-node",
        { scale: 0 },
        { scale: 1, duration: 0.5, ease: "back.out(2)", stagger: 0.06 }
      );
      // After nodes appear, trigger pulse ripple CSS animation
      nodesTl.add(() => {
        document.querySelectorAll(".network-node circle:first-child").forEach((c, i) => {
          setTimeout(() => c.classList.add("node-pulse"), i * 80);
        });
      }, "+=0.1");

      // Feature cards stagger
      gsap.fromTo(".feature-card",
        { y: 32, opacity: 0, filter: "blur(4px)" },
        {
          y: 0, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out", stagger: 0.1,
          scrollTrigger: { trigger: ".feature-cards", start: "top 85%", toggleActions: "play none none none" },
        }
      );

      // ═══ ROADMAP SECTION ═══
      // Section entrance
      gsap.fromTo("#roadmap .roadmap-content",
        { opacity: 0, y: 60 },
        {
          opacity: 1, y: 0, duration: 1.2, ease: "power3.out",
          scrollTrigger: { trigger: "#roadmap", start: "top 75%", toggleActions: "play none none none" },
        }
      );

      // Eyebrow line draws in
      gsap.fromTo("#roadmap .section-eyebrow-line",
        { scaleX: 0, transformOrigin: "left center" },
        {
          scaleX: 1, duration: 0.8, ease: "power3.inOut",
          scrollTrigger: { trigger: "#roadmap", start: "top 68%", toggleActions: "play none none none" },
        }
      );
      gsap.fromTo("#roadmap .atlas-eyebrow",
        { x: -16, opacity: 0 },
        {
          x: 0, opacity: 1, duration: 0.6,
          scrollTrigger: { trigger: "#roadmap", start: "top 66%", toggleActions: "play none none none" },
        }
      );

      // Section title — cinematic word reveal
      gsap.fromTo("#roadmap .split-word",
        { yPercent: 110, opacity: 0 },
        {
          yPercent: 0, opacity: 1, duration: 0.9, ease: "power4.out", stagger: 0.06,
          scrollTrigger: { trigger: "#roadmap", start: "top 70%", toggleActions: "play none none none" },
        }
      );

      // Section number — parallax drift
      gsap.fromTo(".roadmap-section-num",
        { yPercent: 40, opacity: 0, scale: 0.85 },
        {
          yPercent: 0, opacity: 1, scale: 1, duration: 1.2, ease: "expo.out",
          scrollTrigger: { trigger: "#roadmap", start: "top 75%", toggleActions: "play none none none" },
        }
      );
      gsap.to(".roadmap-section-num", {
        yPercent: -40,
        ease: "none",
        scrollTrigger: { trigger: "#roadmap", start: "top bottom", end: "bottom top", scrub: 2 },
      });

      // Roadmap items stagger with clip reveal
      gsap.fromTo(".roadmap-item",
        { y: 40, opacity: 0, clipPath: "inset(15% 0 15% 0)" },
        {
          y: 0, opacity: 1, clipPath: "inset(0% 0 0% 0)", duration: 0.7, ease: "power3.out", stagger: 0.08,
          scrollTrigger: { trigger: ".roadmap-list", start: "top 80%", toggleActions: "play none none none" },
        }
      );

      // Progress fills
      gsap.fromTo(".roadmap-progress-fill",
        { scaleX: 0, transformOrigin: "left center" },
        {
          scaleX: 1, duration: 1, ease: "power2.inOut", stagger: 0.12,
          scrollTrigger: { trigger: ".roadmap-list", start: "top 75%", toggleActions: "play none none none" },
        }
      );

      // ═══ AURORA MESH — continuous rotation ═══
      // Continuous rotation — always alive, independent of scroll
      gsap.to(".aurora-disc-1", {
        rotation: 360, duration: 20, ease: "none", repeat: -1,
      });
      gsap.to(".aurora-disc-2", {
        rotation: -360, duration: 28, ease: "none", repeat: -1,
      });
      gsap.to(".aurora-disc-3", {
        rotation: 360, duration: 35, ease: "none", repeat: -1,
      });

      // Morphing ring — continuous slow rotation
      gsap.to(".aurora-ring", {
        rotation: -360, duration: 40, ease: "none", repeat: -1,
      });

      // Scroll parallax layered on top — discs shift position as you scroll
      gsap.to(".aurora-disc-1", {
        yPercent: -20, scale: 1.1,
        ease: "none",
        scrollTrigger: { trigger: containerRef.current, start: "top top", end: "bottom bottom", scrub: 3 },
      });
      gsap.to(".aurora-disc-2", {
        yPercent: 15, xPercent: -10,
        ease: "none",
        scrollTrigger: { trigger: containerRef.current, start: "top top", end: "bottom bottom", scrub: 4 },
      });

      // Progress bar fills with scroll
      gsap.to(".aurora-progress-fill", {
        scaleX: 1,
        ease: "none",
        scrollTrigger: { trigger: containerRef.current, start: "top top", end: "bottom bottom", scrub: 0.5 },
      });

      // ═══ FOOTER ═══
      gsap.fromTo(".atlas-footer-meta",
        { y: 16, opacity: 0 },
        {
          y: 0, opacity: 1, duration: 0.5, ease: "power2.out",
          scrollTrigger: { trigger: ".atlas-section-footer", start: "top 95%", toggleActions: "play none none none" },
        }
      );
    });

    // ── Mobile animations ───────────────────────────────────────────
    mm.add("(max-width: 1023px)", () => {
      // Login card entrance
      gsap.fromTo(".login-card-anim",
        { y: 16, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.6, ease: "power2.out", delay: 0.2 }
      );

      // Headline words
      gsap.fromTo(".hero-headline .split-word",
        { yPercent: 50, opacity: 0 },
        {
          yPercent: 0, opacity: 1, duration: 0.5, ease: "power2.out", stagger: 0.02,
          scrollTrigger: { trigger: "#hero", start: "top 80%", toggleActions: "play none none none" },
        }
      );

      // Sections fade in
      ["#network", "#roadmap"].forEach((sel) => {
        gsap.fromTo(sel,
          { y: 32, opacity: 0 },
          {
            y: 0, opacity: 1, duration: 0.7, ease: "power2.out",
            scrollTrigger: { trigger: sel, start: "top 85%", toggleActions: "play none none none" },
          }
        );
      });
    });

  }, { scope: containerRef, dependencies: [checkingAuth] });

  // ── Loading state ────────────────────────────────────────────────────
  if (checkingAuth) {
    return (
      <main className="min-h-screen grid place-items-center" style={{ background: "var(--atlas-bg)" }}>
        <div className="atlas-loader">
          <span className="font-display" style={{ fontSize: "28px", color: "var(--atlas-ink)" }}>atlas</span>
          <div className="atlas-loader-bar"><div className="atlas-loader-fill" /></div>
        </div>
      </main>
    );
  }

  return (
    <main
      ref={containerRef}
      data-theme={theme}
      className="relative overflow-x-hidden"
      style={{ background: "var(--atlas-bg)", color: "var(--atlas-ink)" }}
    >
      <ScrollProgress />
      <GrainOverlay />
      <GradientOrbs />
      <ParticleField />

      {/* ── Fixed Header ──────────────────────────────────────────────── */}
      <header className="atlas-landing-header">
        <div className="atlas-landing-brand">
          <span className="atlas-landing-brand-yb">Yogabars</span>
          <span className="atlas-landing-brand-sep" />
          <span className="font-display atlas-wordmark-mark atlas-landing-brand-atlas">atlas</span>
        </div>

        {/* Theme toggle */}
        <div className="atlas-landing-theme-toggle">
          <button
            type="button"
            onClick={() => { setTheme("light"); localStorage.setItem("atlas_login_theme", "light"); }}
            className={`atlas-landing-theme-btn ${theme === "light" ? "active" : ""}`}
            aria-label="Light theme"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          </button>
          <button
            type="button"
            onClick={() => { setTheme("dark"); localStorage.setItem("atlas_login_theme", "dark"); }}
            className={`atlas-landing-theme-btn ${theme === "dark" ? "active" : ""}`}
            aria-label="Dark theme"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── Scroll Layout ─────────────────────────────────────────────── */}
      <div className="atlas-scroll-layout">
        <div className="atlas-scroll-content">
          <HeroSection />
          <NetworkSection />
          <RoadmapSection />

          {/* Footer */}
          <section className="atlas-section-footer">
            <div className="atlas-footer-meta">
              <span>Yogabars &middot; Mumbai</span>
              <span className="atlas-footer-rule" />
              <span>Encrypted at rest &middot; v2.0</span>
            </div>
          </section>
        </div>

        <div className="atlas-login-column">
          <div className="atlas-login-pin-wrapper">
            <LoginCard />
            <AuroraMesh />
          </div>
        </div>
      </div>
    </main>
  );
}

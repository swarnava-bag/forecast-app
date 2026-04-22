"use client";
import { SplitWords } from "./SplitText";

export default function HeroSection() {
  return (
    <section id="hero" className="atlas-section hero-section">
      {/* Giant background wordmark — decorative */}
      <div className="hero-bg-wordmark" aria-hidden="true">atlas</div>

      <div className="hero-content">
        {/* Eyebrow with animated line */}
        <div className="hero-eyebrow-row hero-eyebrow">
          <span className="hero-eyebrow-line" />
          <span className="atlas-eyebrow">Demand planning &middot; Yogabars</span>
        </div>

        {/* Main headline — cinematic split reveal */}
        <h1 className="hero-headline">
          <span className="hero-headline-line">
            <SplitWords text="Every channel," />
          </span>
          <span className="hero-headline-line">
            <SplitWords text="every SKU," />
          </span>
          <span className="hero-headline-line hero-headline-accent">
            <SplitWords text="in one place." />
          </span>
        </h1>

        {/* Lede with reveal */}
        <p className="hero-lede">
          Upload forecasts for all your channels in one file. Combo SKUs
          are auto-converted to singles. Lower revision, higher fidelity.
        </p>

        {/* Horizontal rule that draws in */}
        <div className="hero-divider" />

        {/* Micro stats row */}
        <div className="hero-micro-stats">
          <div className="hero-micro-stat">
            <span className="hero-micro-num" data-count="7" data-suffix="">0</span>
            <span className="hero-micro-label">Channels</span>
          </div>
          <div className="hero-micro-divider" />
          <div className="hero-micro-stat">
            <span className="hero-micro-num" data-count="200" data-suffix="+">0</span>
            <span className="hero-micro-label">SKUs</span>
          </div>
          <div className="hero-micro-divider" />
          <div className="hero-micro-stat">
            <span className="hero-micro-num" data-count="3" data-suffix="mo">0</span>
            <span className="hero-micro-label">Rolling</span>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="scroll-indicator">
          <span className="scroll-indicator-text">Scroll to explore</span>
          <div className="scroll-indicator-track">
            <div className="scroll-indicator-thumb" />
          </div>
        </div>
      </div>
    </section>
  );
}

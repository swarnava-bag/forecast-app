"use client";
import { SplitWords } from "./SplitText";

const EDGES = [
  "M40,60 L120,30", "M40,60 L120,90", "M120,30 L200,50",
  "M120,90 L200,50", "M120,90 L200,100", "M200,50 L280,25",
  "M200,50 L280,70", "M200,100 L280,70", "M280,25 L360,55",
  "M280,70 L360,55",
];

const NODES: [number, number][] = [
  [40, 60], [120, 30], [120, 90], [200, 50], [200, 100],
  [280, 25], [280, 70], [360, 55],
];

const NODE_LABELS = ["Upload", "", "", "Process", "", "", "", "Output"];

const FEATURES = [
  { icon: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z", title: "Multi-channel upload", desc: "One Excel file handles all 7 channels" },
  { icon: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15", title: "Combo auto-split", desc: "Combos resolve to singles via mapper" },
  { icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z", title: "Fidelity analytics", desc: "Track M-1, M-2 forecast accuracy" },
];

export default function NetworkSection() {
  return (
    <section id="network" className="atlas-section network-section">
      {/* Large section number */}
      <div className="section-number network-section-num" aria-hidden="true">02</div>

      <div className="network-content">
        {/* Eyebrow with reveal line */}
        <div className="section-eyebrow-row">
          <span className="section-eyebrow-line" />
          <span className="network-eyebrow atlas-eyebrow">How it works</span>
        </div>

        <h2 className="network-title">
          <span className="section-title-line"><SplitWords text="Upload." /></span>{" "}
          <span className="section-title-line section-title-accent"><SplitWords text="Process." /></span>{" "}
          <span className="section-title-line"><SplitWords text="Output." /></span>
        </h2>

        {/* Full-width network graph with glow */}
        <div className="network-graph-container">
          <svg viewBox="0 0 400 130" fill="none" xmlns="http://www.w3.org/2000/svg" className="network-svg">
            {/* Glow filter */}
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {/* Edges */}
            {EDGES.map((d, i) => (
              <path key={i} d={d} className="network-edge" />
            ))}

            {/* Glowing edges (duplicate for glow effect) */}
            {EDGES.map((d, i) => (
              <path key={`glow-${i}`} d={d} className="network-edge-glow" filter="url(#glow)" />
            ))}

            {/* Nodes */}
            {NODES.map(([cx, cy], i) => (
              <g key={i} className="network-node" style={{ transformOrigin: `${cx}px ${cy}px` }}>
                <circle cx={cx} cy={cy} r="8" fill="var(--atlas-bg)" stroke="var(--atlas-accent)" strokeWidth="1.5" />
                <circle cx={cx} cy={cy} r="3" fill="var(--atlas-accent)" opacity="0.9" />
                {NODE_LABELS[i] && (
                  <text x={cx} y={cy + 22} textAnchor="middle" fill="var(--atlas-ink-muted)" fontSize="9" fontFamily="var(--font-mono)" className="uppercase" letterSpacing="0.1em">{NODE_LABELS[i]}</text>
                )}
              </g>
            ))}
          </svg>
        </div>

        {/* Feature cards */}
        <div className="feature-cards">
          {FEATURES.map((f, i) => (
            <div key={i} className="feature-card">
              <div className="feature-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d={f.icon} />
                </svg>
              </div>
              <div className="feature-text">
                <div className="feature-title">{f.title}</div>
                <div className="feature-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

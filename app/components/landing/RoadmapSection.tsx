"use client";
import { SplitWords } from "./SplitText";

const TOOLKIT = [
  { num: "01", name: "Forecast collation", desc: "Three-month rolling forecasts across every channel, unified in one platform.", status: "live" as const },
  { num: "02", name: "Combo to Singles", desc: "Combo SKUs automatically resolve to individual components via the mapper.", status: "live" as const },
  { num: "03", name: "SKU & FG management", desc: "Complete master data administration with bulk import and version tracking.", status: "live" as const },
  { num: "04", name: "MRP change tracker", desc: "Track FG code changes across MRP and artwork revisions over time.", status: "soon" as const },
  { num: "05", name: "Demand analytics", desc: "Forecast accuracy scoring, trend insights, and fidelity metrics.", status: "soon" as const },
];

export default function RoadmapSection() {
  return (
    <section id="roadmap" className="atlas-section roadmap-section">
      {/* Large section number */}
      <div className="section-number roadmap-section-num" aria-hidden="true">03</div>

      <div className="roadmap-content">
        {/* Eyebrow with reveal line */}
        <div className="section-eyebrow-row">
          <span className="section-eyebrow-line" />
          <span className="roadmap-eyebrow atlas-eyebrow">Platform roadmap</span>
        </div>

        <h2 className="roadmap-title">
          <span className="section-title-line"><SplitWords text="Built for" /></span>{" "}
          <span className="section-title-line section-title-accent"><SplitWords text="demand teams." /></span>
        </h2>

        {/* Roadmap items — editorial style */}
        <div className="roadmap-list">
          {TOOLKIT.map((item, i) => (
            <div key={item.num} className={`roadmap-item ${item.status === "soon" ? "roadmap-item-soon" : ""}`}>
              <div className="roadmap-item-num">{item.num}</div>
              <div className="roadmap-item-body">
                <div className="roadmap-item-header">
                  <h3 className="roadmap-item-name">{item.name}</h3>
                  <span className={`roadmap-status roadmap-status-${item.status}`}>
                    {item.status === "live" ? "Live" : "Coming Soon"}
                  </span>
                </div>
                <p className="roadmap-item-desc">{item.desc}</p>
              </div>
              {/* Progress bar for live items */}
              {item.status === "live" && (
                <div className="roadmap-progress">
                  <div className="roadmap-progress-fill" style={{ width: "100%" }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

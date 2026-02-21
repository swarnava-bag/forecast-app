import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Demand Planning Module – Yogabars";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#030712",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Logo mark — stacked bars icon */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: "10px", marginBottom: "40px" }}>
          <div style={{ width: "18px", height: "32px", background: "#f59e0b", borderRadius: "4px" }} />
          <div style={{ width: "18px", height: "52px", background: "#f59e0b", borderRadius: "4px" }} />
          <div style={{ width: "18px", height: "44px", background: "#f59e0b", borderRadius: "4px" }} />
          <div style={{ width: "18px", height: "64px", background: "#f59e0b", borderRadius: "4px" }} />
          <div style={{ width: "18px", height: "40px", background: "#f59e0b", borderRadius: "4px" }} />
          <div style={{ width: "18px", height: "56px", background: "#f59e0b", borderRadius: "4px" }} />
        </div>

        {/* Title */}
        <div
          style={{
            fontSize: "64px",
            fontWeight: "700",
            color: "#ffffff",
            lineHeight: 1.1,
            marginBottom: "20px",
            letterSpacing: "-1px",
          }}
        >
          Demand Planning Module
        </div>

        {/* Brand name */}
        <div
          style={{
            fontSize: "40px",
            fontWeight: "600",
            color: "#f59e0b",
            marginBottom: "32px",
          }}
        >
          Yogabars
        </div>

        {/* Description */}
        <div
          style={{
            fontSize: "24px",
            color: "#6b7280",
            maxWidth: "700px",
            lineHeight: 1.5,
          }}
        >
          Channel forecasts · Cluster &amp; SKU analysis · Pivot views
        </div>

        {/* Bottom divider line */}
        <div
          style={{
            position: "absolute",
            bottom: "0",
            left: "0",
            right: "0",
            height: "6px",
            background: "linear-gradient(90deg, #f59e0b, #d97706)",
          }}
        />
      </div>
    ),
    { ...size }
  );
}

import type { Metadata } from "next";
import { Inter, Instrument_Serif, Geist_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Demand Planning Module – Yogabars",
  description: "Internal forecast collation and demand planning tool for the Yogabars team. Upload, review, and analyse channel forecasts by cluster, SKU, and pivot views.",
  openGraph: {
    title: "Demand Planning Module – Yogabars",
    description: "Upload, review, and analyse channel forecasts by cluster, SKU, and pivot views.",
    siteName: "Yogabars Demand Planning",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Demand Planning Module – Yogabars",
    description: "Upload, review, and analyse channel forecasts by cluster, SKU, and pivot views.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${instrumentSerif.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

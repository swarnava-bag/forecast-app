import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

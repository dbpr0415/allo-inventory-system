import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Allo Inventory System",
  description: "Multi-warehouse inventory reservation platform with concurrency control",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="min-h-screen bg-slate-50">
          <header className="border-b bg-white shadow-sm">
            <div className="container mx-auto px-4 py-4">
              <h1 className="text-2xl font-bold text-blue-600">Allo Inventory</h1>
              <p className="text-sm text-slate-600">Multi-warehouse order fulfillment platform</p>
            </div>
          </header>
          <main>{children}</main>
          <footer className="mt-auto border-t bg-white py-4">
            <div className="container mx-auto px-4 text-center text-sm text-slate-600">
              Built with Next.js, Prisma, Redis, and Vercel Cron
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

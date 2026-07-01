"use client";

export const runtime = "edge";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { SkeletonList } from "@/components/States";

export default function LegacyKinkDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(params.id || "");

  useEffect(() => {
    if (!id) return;
    router.replace(`/inspiration/kink?id=${encodeURIComponent(id)}`);
  }, [id, router]);

  return (
    <AppShell hideTabBar>
      <header className="sheet-header">
        <Link href="/inspiration" className="fd-back pressable" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="sheet-title">Kink</span>
        <span className="sheet-header-spacer" aria-hidden="true" />
      </header>
      <SkeletonList count={3} />
    </AppShell>
  );
}

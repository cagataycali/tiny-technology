"use client";

/**
 * /voice — legacy deep-link shim.
 *
 * The standalone call surface is gone (voice-inline design,
 * docs/voice-sessions-design.md "Inline-chat iteration"): a call now lives
 * INSIDE the textual chat — the 📞 button / the /voice slash command start it
 * in place, transcription lands in the thread, and the composer stays live.
 * Old links and bookmarks (/voice?tiny=name) land in that tiny's chat, where
 * the call button is one tap away — no auto-start: browsers want the mic/
 * audio gesture to be the user's own.
 */

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function VoiceRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const tiny = (params.get("tiny") || "").trim();
    router.replace(tiny ? `/${encodeURIComponent(tiny)}` : "/");
  }, [params, router]);
  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-neutral-400">
      Calls live in the chat now — taking you there…
    </main>
  );
}

export default function VoicePage() {
  return (
    <Suspense fallback={null}>
      <VoiceRedirect />
    </Suspense>
  );
}

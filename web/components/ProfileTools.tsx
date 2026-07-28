"use client";

/**
 * Client island for a profile's forged-tool list.
 *
 * Profile is a server component, but "is this MY profile?" is a session
 * question — so the tool grid hydrates client-side, asks /api/me once,
 * and when the visitor owns the profile each card gains a delete action
 * (DELETE /api/tools, which already existed but had no surface here —
 * tools could only be removed by asking the AI to remove_tool).
 *
 * Deletion updates local state so the card disappears without a reload.
 */
import { useEffect, useState } from "react";
import ProfileToolCard, { type ProfileTool } from "./ProfileToolCard";
import { deadlineFor } from "../lib/deadlines";

export default function ProfileTools({
  tools: initialTools,
  ownerLogin,
}: {
  tools: ProfileTool[];
  ownerLogin: string;
}) {
  const [tools, setTools] = useState<ProfileTool[]>(initialTools);
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    // One session check for the whole grid (not per card). Deadlined: a hang
    // leaves `isOwner` false forever, so the owner silently loses every delete
    // control on their own profile with nothing to indicate why.
    fetch("/api/me", { signal: AbortSignal.timeout(deadlineFor("/api/me")) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const login = d?.user?.login;
        if (login && login.toLowerCase() === ownerLogin.toLowerCase()) setIsOwner(true);
      })
      .catch(() => { /* signed-out visitors just don't get delete */ });
  }, [ownerLogin]);

  if (tools.length === 0) {
    return (
      <div className="text-sm text-gray-400">
        No forged tools yet — tools are created by chatting (create_tool).
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {tools.map((t) => (
        <ProfileToolCard
          key={t.name}
          tool={t}
          ownerLogin={ownerLogin}
          canDelete={isOwner}
          onDeleted={() => setTools((prev) => prev.filter((x) => x.name !== t.name))}
        />
      ))}
    </div>
  );
}

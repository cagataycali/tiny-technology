"use client";

/**
 * Task tree (COMPARISON.md wishlist — spawn_agents visualization).
 *
 * Renders a spawn_agents tool call as a fan-out tree instead of the generic
 * input/result JSON card: one node per sub-agent with live status (spinner
 * while the batch runs, ✓/✗ after), prompt preview, and expandable result.
 *
 * Streaming reality: tool input arrives at toolUseEvent (tasks known,
 * results pending → every node shows "running"), the result lands with
 * toolResultEvent and flips nodes to their final state.
 */
import { IconCpu } from "./icons";
import { useState } from "react";
import { pluralize } from "../../lib/utils";

type SpawnTask = { prompt: string; system_prompt?: string };
type SpawnResult = { task: number; ok: boolean; result?: string; error?: string };

export default function TaskTree({
  input,
  result,
  status,
}: {
  input?: { tasks?: SpawnTask[] };
  result?: { ok?: boolean; elapsed_ms?: number; completed?: number; failed?: number; results?: SpawnResult[] };
  status: "calling" | "success" | "error";
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const tasks: SpawnTask[] = input?.tasks || [];
  const results: SpawnResult[] = result?.results || [];

  if (tasks.length === 0) return null;

  const nodeFor = (i: number) => results.find((r) => r.task === i + 1);

  return (
    <div
      className="px-4 py-3 rounded-xl border"
      style={{
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(10px)",
        borderColor:
          status === "calling" ? "rgba(var(--tiny-accent-rgb),0.5)"
          : status === "success" ? "rgba(var(--tiny-accent-rgb),0.3)"
          : "rgba(var(--tiny-danger-rgb),0.5)",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        {status === "calling" ? (
          <span
            role="status"
            aria-label={`${pluralize(tasks.length, "sub-agent")} running`}
            className="inline-block w-3 h-3 rounded-full animate-spin"
            style={{ border: "2px solid rgba(var(--tiny-accent-rgb),0.3)", borderTopColor: "var(--tiny-accent)" }}
          />
        ) : (
          <IconCpu className="w-4 h-4" style={{ color: "var(--tiny-accent)" }} />
        )}
        <span className="font-mono text-xs font-semibold" style={{ color: "var(--tiny-accent)" }}>
          spawn_agents · {tasks.length} parallel
        </span>
        {result?.elapsed_ms !== undefined && (
          <span className="text-[10px] text-gray-400 ml-auto font-mono">
            {result.completed ?? results.filter((r) => r.ok).length}/{tasks.length} ok
            {Number.isFinite(Number(result.elapsed_ms)) && ` · ${(Number(result.elapsed_ms) / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      <div className="mt-2">
        {tasks.map((task, i) => {
          const node = nodeFor(i);
          const running = status === "calling" && !node;
          // Batch errored before this agent produced a result → it will never
          // run. Distinct from "queued" (·), which implies still-pending: a
          // failed batch has nothing pending, so a grey dot would read as
          // permanently-in-progress to sighted and SR users alike.
          const didNotRun = status === "error" && !node;
          const isOpen = openIdx === i;
          const last = i === tasks.length - 1;
          return (
            <div key={i} className="flex gap-2">
              {/* tree rail */}
              <div className="flex flex-col items-center w-4 shrink-0 font-mono text-xs" style={{ color: "rgba(var(--tiny-accent-rgb),0.4)" }}>
                <span>{last ? "└" : "├"}</span>
                {!last && <span className="flex-1 border-l" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.2)" }} />}
              </div>

              <div className="min-w-0 flex-1 pb-1.5">
                <button
                  className="w-full text-left flex items-start gap-2 group"
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                  disabled={!node}
                  aria-expanded={node ? isOpen : undefined}
                >
                  {/* role="img" so each status glyph's aria-label is a reliable
                      accessible name — aria-label on a role-less <span> is
                      inconsistently announced, which would leave a SR user
                      hearing each sub-agent's prompt but not whether it
                      succeeded, failed, or is still running (the one piece of
                      state that matters most in a parallel-agent tree). */}
                  <span className="shrink-0 text-xs mt-0.5">
                    {running ? (
                      <span
                        role="img"
                        aria-label="running"
                        className="inline-block w-2.5 h-2.5 rounded-full animate-spin"
                        style={{ border: "2px solid rgba(var(--tiny-accent-rgb),0.3)", borderTopColor: "var(--tiny-accent)" }}
                      />
                    ) : node?.ok ? (
                      <span role="img" aria-label="succeeded" style={{ color: "var(--tiny-accent)" }}>✓</span>
                    ) : node ? (
                      <span role="img" aria-label="failed" style={{ color: "var(--tiny-danger)" }}>✗</span>
                    ) : didNotRun ? (
                      <span role="img" aria-label="did not run" style={{ color: "rgba(var(--tiny-danger-rgb),0.6)" }}>✗</span>
                    ) : (
                      <span role="img" aria-label="queued" className="text-gray-600">·</span>
                    )}
                  </span>
                  <span className={`text-xs truncate ${node ? "text-gray-300 group-hover:text-white cursor-pointer" : "text-gray-400"}`}>
                    #{i + 1} {task.prompt}
                  </span>
                </button>
                {isOpen && node && (
                  <div className="mt-1.5 ml-5 p-2 rounded-lg bg-black/50 text-xs text-gray-300 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                    {node.ok ? node.result : <span className="text-red-400">Error: {node.error}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

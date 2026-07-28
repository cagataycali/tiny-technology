"use client";

/**
 * Print-opens every closed <details> and restores them after (backlog v4
 * C6). The @media print block in globals.css unclamps scroll caps — but CSS
 * cannot open a closed <details>, so tool Inputs/Results and Reasoning
 * (the evidence of what the agent DID) silently vanished from printed
 * conversations. beforeprint/afterprint bracket both the toolbar print
 * button and Cmd/Ctrl+P.
 *
 * Only the elements THIS hook opened are re-closed — a details the user
 * had open stays open after printing.
 */
import { useEffect } from "react";

export function usePrintDetails() {
  useEffect(() => {
    let touched: HTMLDetailsElement[] = [];
    const before = () => {
      touched = Array.from(document.querySelectorAll<HTMLDetailsElement>("details:not([open])"));
      touched.forEach((d) => { d.open = true; });
    };
    const after = () => {
      touched.forEach((d) => { d.open = false; });
      touched = [];
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
}

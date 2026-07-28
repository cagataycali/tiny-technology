"use client";

import { useMemo } from "react";
import * as Recharts from "recharts";
import React from "react";

type UIComponentProps = {
  id: string;
  componentCode?: string; // Dynamic React code
  props?: any;
  title?: string;
};

export default function DynamicUI({
  id,
  componentCode,
  props = {},
  title,
}: UIComponentProps) {
  // Dynamically evaluate and create a React component
  const DynamicComponent = useMemo(() => {
    if (!componentCode) {
      return null;
    }

    try {
      // Create a component function that returns the evaluated code.
      // Make createElement available as h for convenience.
      //
      // 🔒 Realm shadowing (defense-in-depth, same posture as
      // lib/user-tools' frozen scope): the trailing params shadow the page
      // globals agent code must never reach — localStorage holds BYOK keys,
      // fetch/XHR exfiltrate, document/window walk to both. A chart needs
      // React + recharts and nothing else. Shares already strip
      // uiComponents at every boundary; this closes the naive channel if
      // any foreign componentCode ever slips through a future path.
      const componentFunction = new Function(
        'React',
        'recharts',
        'localStorage', 'sessionStorage', 'document', 'window',
        'globalThis', 'fetch', 'XMLHttpRequest', 'navigator', 'cookieStore',
        `
        "use strict";
        const { useState, useEffect, useMemo, useCallback, useRef, createElement: h } = React;
        const createElement = React.createElement;
        return ${componentCode};
        `
      );

      // Only the two real capabilities are passed; the shadows stay undefined.
      const Component = componentFunction(React, Recharts);
      
      return Component;
    } catch (err: any) {
      console.error("Component parsing error:", err);
      const ParseError = () => React.createElement('div', {
        className: 'text-red-400 font-semibold mb-2'
      }, `❌ Component Error: ${err.message}`);
      ParseError.displayName = 'DynamicUIParseError';
      return ParseError;
    }
  }, [componentCode]);

  // Render error if no component
  if (!DynamicComponent) {
    return (
      <div className="my-4 p-4 rounded-xl border" style={{
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(10px)',
        borderColor: 'rgba(255,0,0,0.3)'
      }}>
        <div className="text-red-400">No component code provided</div>
      </div>
    );
  }

  // Enrich props with recharts if needed
  const enrichedProps = {
    ...props,
    recharts: props.recharts === "RECHARTS_LIBRARY" ? Recharts : props.recharts,
  };

  // Render the dynamic component with error boundary
  return (
    <div className="my-4">
      {title && (
        <h3 className="text-lg font-bold mb-4" style={{ color: 'var(--tiny-accent)' }}>
          {title}
        </h3>
      )}
      {/* overflow-x-auto: agent-generated content (wide charts/tables) must
          scroll inside the panel, not blow out the bubble column on mobile */}
      <div className="rounded-xl border overflow-x-auto" style={{
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(10px)',
        borderColor: 'rgba(var(--tiny-accent-rgb),0.2)',
        padding: '1rem'
      }}>
        <ErrorBoundary componentCode={componentCode}>
          <DynamicComponent {...enrichedProps} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

// Error boundary component
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; componentCode?: string },
  { hasError: boolean; error: any }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Component render error:", error, errorInfo);
  }

  // Reset when the code changes — otherwise a fixed re-render stays stuck
  // on the previous error card (the boundary instance is reused in place).
  componentDidUpdate(prev: { componentCode?: string }) {
    if (this.state.hasError && prev.componentCode !== this.props.componentCode) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert">
          <div className="text-red-400 font-semibold mb-2">
            ❌ This panel failed to render
          </div>
          <div className="text-sm text-gray-400 mb-2">
            {this.state.error?.message || String(this.state.error)} — ask the
            tiny to fix or re-render it.
          </div>
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer hover:text-gray-400">View component code</summary>
            <pre className="mt-2 p-2 rounded-lg bg-black/50 overflow-x-auto whitespace-pre-wrap break-words">
              {this.props.componentCode}
            </pre>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

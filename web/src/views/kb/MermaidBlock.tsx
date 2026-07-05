import { useEffect, useId, useState } from 'react';
import DOMPurify from 'dompurify';

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
export function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

// Strip <foreignObject> (HTML-in-SVG) and every external-resource / script / link
// vector from mermaid's SVG before it is injected. mermaid's own theme <style>,
// <path>, <text>, <g>, markers, etc. are preserved by the svg profile, so the
// diagram still renders fully styled; a malicious HTML label degrades to inert
// escaped text. Verified against <img src=x onerror=…>, <script>, and
// click "javascript:…" payloads — none survive.
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'foreignObject', 'img', 'image', 'script', 'iframe', 'object',
      'embed', 'a', 'audio', 'video', 'source', 'link', 'base',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'onerror', 'onload', 'onclick'],
  });
}

export function MermaidBlock({ code }: { code: string }) {
  const reactId = useId();
  // Single state set only from the async resolution, so there's no synchronous
  // setState in the effect (and no flicker: the prior diagram stays until the
  // next one resolves). `svg: null, failed: false` is the loading state.
  const [state, setState] = useState<{ svg: string | null; failed: boolean }>({
    svg: null,
    failed: false,
  });

  useEffect(() => {
    let cancelled = false;
    // mermaid requires a DOM-id-safe string; React's useId contains ':'.
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, code))
      .then(({ svg }) => {
        if (!cancelled) setState({ svg, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ svg: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  const { svg, failed } = state;

  // On parse/render failure, fall back to showing the raw source so the
  // author can still read and fix it (matches GitHub's behavior).
  if (failed) {
    return (
      <pre className="font-mono text-[0.82em] leading-[1.55] text-text-muted" style={{ background: 'transparent', margin: 0 }}>
        {code}
      </pre>
    );
  }
  if (svg === null) {
    return <div className="px-3 py-4 text-[0.82em] text-text-subtle">Rendering diagram…</div>;
  }
  return (
    <div
      className="flex justify-center overflow-x-auto px-3 py-3 [&_svg]:max-w-full [&_svg]:h-auto"
      // svg-only sanitized (no foreignObject / img / script / event attrs / active links) — see sanitizeMermaidSvg
      dangerouslySetInnerHTML={{ __html: sanitizeMermaidSvg(svg) }}
    />
  );
}

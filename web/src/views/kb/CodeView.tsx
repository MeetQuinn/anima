import { useCallback, useEffect, useRef, useState } from 'react';
import { WrapText } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import { CopyButton } from './FileChrome';
import { lineFromHash } from './lib/markdown-toc';
import { loadSessionWrap, saveSessionWrap } from './lib/view-prefs';

export function CodeView({ body, language }: { body: string; language: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeLine, setActiveLine] = useState<number | null>(() => lineFromHash(window.location.hash));
  // Soft-wrap toggle. Default ON (long lines wrap, no horizontal scroll);
  // turning it off gives GitHub-style no-wrap + horizontal scroll. Remembered
  // per tab session like the view mode.
  const [wrap, setWrap] = useState<boolean>(loadSessionWrap);
  const toggleWrap = useCallback(() => {
    setWrap((prev) => {
      const next = !prev;
      saveSessionWrap(next);
      return next;
    });
  }, []);

  useEffect(() => {
    function onHashChange() {
      setActiveLine(lineFromHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Bring the deep-linked line into view once, after the highlighter paints.
  useEffect(() => {
    const target = lineFromHash(window.location.hash);
    if (target === null) return;
    const el = scrollRef.current?.querySelector(`#L${target}`);
    if (!el) return;
    const t = setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => clearTimeout(t);
    // Intentionally mount-only: deep-link landing, not on every hash edit.
  }, []);

  function selectLine(n: number) {
    const next = activeLine === n ? null : n;
    setActiveLine(next);
    // replaceState keeps the back button clean while updating the shareable URL.
    const url = next === null ? window.location.pathname + window.location.search : `#L${next}`;
    window.history.replaceState(null, '', url);
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div className="relative group min-h-0 flex-1 overflow-auto">
        <button
          type="button"
          onClick={toggleWrap}
          aria-pressed={wrap}
          title={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}
          className={[
            'chrome absolute right-12 top-2 z-10 flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] transition-opacity',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
            wrap
              ? 'bg-accent/10 text-accent hover:bg-accent/15'
              : 'bg-surface-elevated/80 text-text-subtle hover:bg-surface-elevated hover:text-text',
          ].join(' ')}
        >
          <WrapText className="h-3 w-3" />
        </button>
        <CopyButton text={body} />
        <Highlight code={body.replace(/\n$/, '')} language={language} theme={themes.github}>
          {({ className, style, tokens, getLineProps, getTokenProps }) => (
            <pre
              className={`${className} min-h-full font-mono text-[12.5px] leading-relaxed ${wrap ? '' : 'w-max'}`}
              style={{
                ...style,
                background: 'transparent',
                padding: 0,
                whiteSpace: wrap ? 'pre-wrap' : 'pre',
                wordBreak: wrap ? 'break-word' : 'normal',
              }}
            >
              <div className="py-4">
                {tokens.map((line, i) => {
                  const n = i + 1;
                  const { className: lineClass, ...lineProps } = getLineProps({ line });
                  const active = activeLine === n;
                  return (
                    <div
                      key={i}
                      {...lineProps}
                      id={`L${n}`}
                      className={[
                        lineClass ?? '',
                        'flex px-5',
                        wrap ? '' : 'min-w-full',
                        active ? 'bg-accent/10' : '',
                      ]
                        .join(' ')
                        .trim()}
                    >
                      <a
                        href={`#L${n}`}
                        onClick={(e) => {
                          e.preventDefault();
                          selectLine(n);
                        }}
                        title={`Link to line ${n}`}
                        className={[
                          'mr-4 inline-block w-8 shrink-0 select-none text-right tabular-nums transition-colors',
                          active ? 'text-accent' : 'text-text-subtle/50 hover:text-text-muted',
                        ].join(' ')}
                      >
                        {n}
                      </a>
                      <span className={wrap ? 'min-w-0 flex-1' : 'shrink-0'}>
                        {line.map((token, key) => {
                          const tokenProps = getTokenProps({ token });
                          return <span key={key} {...tokenProps} />;
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
}

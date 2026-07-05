import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function ImageLightbox({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const openLightbox = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const closeLightbox = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeButtonRef.current?.focus();
      }
    }
    closeButtonRef.current?.focus();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previousFocusRef.current?.focus();
    };
  }, [closeLightbox, open]);

  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={openLightbox}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openLightbox();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={alt ? `Open image: ${alt}` : 'Open image'}
        className="max-w-full cursor-zoom-in rounded"
      />
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt ? `Image preview: ${alt}` : 'Image preview'}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={closeLightbox}
        >
          <button
            ref={closeButtonRef}
            onClick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
            aria-label="Close image preview"
            title="Close"
            className="chrome absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm bg-black/40 text-white transition-colors hover:bg-black/60 focus-visible:bg-black/60"
          >
            <X className="h-4 w-4" />
          </button>
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {alt && (
            <div className="chrome absolute bottom-4 left-4 right-4 rounded-sm bg-black/45 px-3 py-2 text-center text-[12px] text-white/85">
              {alt}
            </div>
          )}
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { FileText, FileWarning, Paperclip, ExternalLink, X } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import type { OutboundFile } from '@/lib/activity-feed';
import type { SlackFile } from '@/types';

export function isImageMime(mimetype: string): boolean {
  return mimetype.startsWith('image/');
}

export function fileHref(agentId: string, fileId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(fileId)}`;
}

export function slackThumbHref(agentId: string, fileId: string, size: 360 | 720): string {
  return `/api/agents/${encodeURIComponent(agentId)}/slack-thumb/${encodeURIComponent(fileId)}?size=${size}`;
}

// ---------------------------------------------------------------------------
// Inbound attached files (Slack uploads received by the agent)
// ---------------------------------------------------------------------------

export function AttachedFiles({ files, agentId }: { files: SlackFile[]; agentId: string }) {
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {files.map((file) => (
        <AttachedFile key={file.id} file={file} agentId={agentId} />
      ))}
    </div>
  );
}

export function AttachedFile({ file, agentId }: { file: SlackFile; agentId: string }) {
  const cached = Boolean(file.localPath);
  const isImage = isImageMime(file.mimetype);
  const href = cached ? fileHref(agentId, file.id) : undefined;
  if (file.downloadError) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-health-error/60 bg-health-error-soft px-2 py-1 font-sans text-[11px] text-health-error"
        title={file.downloadError}
      >
        <FileWarning className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <span className="shrink-0 text-text-subtle">download failed</span>
      </span>
    );
  }
  if (isImage && href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="block max-w-full overflow-hidden rounded-sm border border-border-soft hover:border-border-strong"
        title={`${file.name} · ${formatBytes(file.sizeBytes)}`}
      >
        <img
          src={href}
          alt={file.name}
          loading="lazy"
          className="block max-h-32 max-w-[14rem] object-cover"
        />
      </a>
    );
  }
  const Inner = (
    <>
      {isImage ? (
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      <span className="shrink-0 text-text-subtle">{formatBytes(file.sizeBytes)}</span>
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border-soft bg-surface-raised px-2 py-1 font-sans text-[11px] text-text-muted hover:border-border-strong hover:text-text"
        title={`${file.mimetype} · ${formatBytes(file.sizeBytes)}`}
      >
        {Inner}
      </a>
    );
  }
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border-soft bg-surface-raised px-2 py-1 font-sans text-[11px] text-text-subtle"
      title={`${file.mimetype} · ${formatBytes(file.sizeBytes)} (not cached: call \`anima file fetch ${file.id}\`)`}
    >
      {Inner}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Outbound uploaded files (files sent by the agent to Slack)
// ---------------------------------------------------------------------------

export function UploadedFile({ file, agentId }: { file: OutboundFile; agentId: string }) {
  const isImage = isImageMime(file.mimetype);
  const permalink = file.permalink;
  const thumb = isImage ? slackThumbHref(agentId, file.fileId, 360) : undefined;
  // Slack's thumbnail pipeline doesn't generate previews for every image type
  // (notably SVG, and occasional GIF/HEIC). When the thumb 404s or fails to
  // decode, fall through to the icon-pill render instead of showing a broken
  // image. Track this per-file with state so a single failure doesn't block
  // the row.
  const [thumbFailed, setThumbFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  if (isImage && thumb && !thumbFailed) {
    // Click opens an in-app lightbox at the 720 thumb size (large
    // enough for the reading flow; "Open in Slack" inside the lightbox is
    // the escape hatch for full-resolution). Previous behaviour was to
    // bounce the user to Slack on every thumbnail click — broke the
    // editorial in-app reading flow.
    return (
      <>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="block max-w-full overflow-hidden rounded-sm border border-border-soft transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          title={`${file.filename} · ${formatBytes(file.sizeBytes)} · click to enlarge`}
        >
          <img
            src={thumb}
            alt={file.filename}
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="block max-h-32 max-w-[14rem] object-cover"
          />
        </button>
        {lightboxOpen && (
          <ImageLightbox
            file={file}
            agentId={agentId}
            permalink={permalink}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    );
  }
  const Inner = (
    <>
      {isImage ? (
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{file.filename}</span>
      <span className="shrink-0 text-text-subtle">{formatBytes(file.sizeBytes)}</span>
    </>
  );
  if (permalink) {
    return (
      <a
        href={permalink}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border-soft bg-surface-raised px-2 py-1 font-sans text-[11px] text-text-muted hover:border-border-strong hover:text-text"
        title={`${file.mimetype} · ${formatBytes(file.sizeBytes)}`}
      >
        {Inner}
      </a>
    );
  }
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border-soft bg-surface-raised px-2 py-1 font-sans text-[11px] text-text-subtle"
      title={`${file.mimetype} · ${formatBytes(file.sizeBytes)}`}
    >
      {Inner}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Image lightbox
// ---------------------------------------------------------------------------

export function ImageLightbox({
  file,
  agentId,
  permalink,
  onClose,
}: {
  file: OutboundFile;
  agentId: string;
  permalink: string | undefined;
  onClose: () => void;
}) {
  const fullThumb = slackThumbHref(agentId, file.fileId, 720);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    // Lock body scroll behind the modal so a long Activity feed underneath
    // can't trampoline the page while the user is examining the image.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/85 p-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={`${file.filename} preview`}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-sm border border-border-soft bg-surface text-text-muted shadow-deep hover:border-border-strong hover:text-text"
        title="Close (Esc)"
        aria-label="Close preview"
      >
        <X className="h-4 w-4" />
      </button>
      <div
        className="flex max-h-full max-w-full flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {imgFailed ? (
          <div className="flex flex-col items-center gap-2 rounded-sm border border-border-soft bg-surface px-8 py-10 text-center shadow-deep">
            <FileWarning className="h-6 w-6 text-text-subtle" />
            <div className="font-serif text-[15px] text-text-muted">Preview unavailable</div>
            <div className="font-sans text-[12px] text-text-subtle">
              Slack didn't generate a thumbnail for this image.
            </div>
          </div>
        ) : (
          <img
            src={fullThumb}
            alt={file.filename}
            onError={() => setImgFailed(true)}
            className="block max-h-[80vh] max-w-[90vw] rounded-sm border border-border-soft bg-surface object-contain shadow-deep"
          />
        )}
        <div className="flex max-w-full items-center gap-3 rounded-sm border border-border-soft bg-surface px-3 py-2 font-sans text-[12px] text-text-muted shadow-deep">
          <span className="truncate" title={file.filename}>
            {file.filename}
          </span>
          <span className="text-text-subtle">·</span>
          <span className="shrink-0 text-text-subtle">{formatBytes(file.sizeBytes)}</span>
          {permalink && (
            <>
              <span className="text-text-subtle">·</span>
              <a
                href={permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
              >
                Open in Slack
                <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

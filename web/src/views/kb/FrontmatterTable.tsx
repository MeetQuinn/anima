import { dedentBlock, stripQuotes } from './lib/frontmatter';
import type { FrontmatterEntry } from './lib/frontmatter';

function FrontmatterBlockValue({ block }: { block: string[] }) {
  const dedented = dedentBlock(block);
  const nonEmpty = dedented.filter((line) => line.trim() !== '');
  const isList = nonEmpty.length > 0 && nonEmpty.every((line) => /^-[ \t]+/.test(line));
  if (isList) {
    return (
      <ul className="m-0 list-disc space-y-0.5 pl-4">
        {nonEmpty.map((line, idx) => (
          <li key={idx} className="font-mono text-[12px] text-text">
            {stripQuotes(line.replace(/^-[ \t]+/, '').trim())}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text">
      {dedented.join('\n').trimEnd()}
    </pre>
  );
}

export function FrontmatterTable({ entries }: { entries: FrontmatterEntry[] }) {
  return (
    <div className="mb-5 overflow-hidden rounded-sm border border-border-soft bg-surface-raised/30">
      <table className="m-0 w-full border-collapse text-left align-top">
        <tbody>
          {entries.map((entry, idx) => (
            <tr
              key={entry.key + idx}
              className={idx > 0 ? 'border-t border-border-soft/70' : undefined}
            >
              <th
                scope="row"
                className="w-px whitespace-nowrap border-r border-border-soft/70 bg-surface-raised/40 px-3 py-2 align-top font-sans text-[11px] font-semibold uppercase tracking-wide text-text-subtle"
              >
                {entry.key}
              </th>
              <td className="px-3 py-2 align-top font-mono text-[12px] text-text">
                {entry.block ? (
                  <FrontmatterBlockValue block={entry.block} />
                ) : (
                  <span className="break-words">{entry.value}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

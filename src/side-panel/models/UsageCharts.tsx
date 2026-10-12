import type { UsageRow } from '@extension/storage';
import { formatTokens, formatUsd } from './ui';

/**
 * Usage as plain SVG bars, no chart library: cost when any call in view had a price, tokens otherwise.
 * Each chart also carries its numbers as text for screen readers.
 */

export type Measure = 'cost' | 'tokens';

export function measureOf(rows: UsageRow[]): Measure {
  return rows.some(row => row.costUsd > 0) ? 'cost' : 'tokens';
}

const valueOf = (row: UsageRow, measure: Measure) =>
  measure === 'cost' ? row.costUsd : row.inputTokens + row.outputTokens;

export const formatValue = (value: number, measure: Measure) =>
  measure === 'cost' ? formatUsd(value) : `${formatTokens(value)} tok`;

/** One bar per day, oldest on the left; the newest day is labelled. */
export function DayBars({ rows, label, measure }: { rows: UsageRow[]; label: string; measure: Measure }) {
  const max = Math.max(...rows.map(row => valueOf(row, measure)), 0);
  const width = 100;
  const height = 56;
  const gap = rows.length > 40 ? 0.3 : 1;
  const barWidth = rows.length ? (width - gap * (rows.length - 1)) / rows.length : 0;
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        className="h-16 w-full">
        <line x1="0" y1={height - 0.25} x2={width} y2={height - 0.25} stroke="var(--color-border)" strokeWidth="0.5" />
        {rows.map((row, index) => {
          const value = valueOf(row, measure);
          const barHeight = max > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / max) * (height - 4)) : 0;
          return (
            <rect
              key={row.key}
              x={index * (barWidth + gap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx="0.6"
              fill="rgb(var(--primary-rgb) / 0.75)">
              <title>{`${row.key}: ${formatValue(value, measure)}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="text-muted-foreground mt-1 flex justify-between font-mono text-[10px]">
        <span>{rows[0]?.key.slice(5)}</span>
        <span>{rows.at(-1)?.key.slice(5)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <th scope="row">{row.key}</th>
              <td>{formatValue(valueOf(row, measure), measure)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The biggest rows as horizontal bars, with their names; the rest add up into "Other". */
export function RankBars({
  rows,
  label,
  measure,
  nameOf,
  otherLabel,
  limit = 8,
}: {
  rows: UsageRow[];
  label: string;
  measure: Measure;
  nameOf: (key: string) => string;
  otherLabel: string;
  limit?: number;
}) {
  const top = rows.slice(0, limit).map(row => ({ name: nameOf(row.key), value: valueOf(row, measure), row }));
  const rest = rows.slice(limit).reduce((sum, row) => sum + valueOf(row, measure), 0);
  const items = rest > 0 ? [...top, { name: otherLabel, value: rest, row: null }] : top;
  const max = Math.max(...items.map(item => item.value), 0);
  return (
    <ul aria-label={label} className="space-y-1.5">
      {items.map(item => (
        <li key={item.row?.key ?? '__other'} className="text-[11.5px]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-[10.5px]">
              {formatValue(item.value, measure)}
              {item.row && measure === 'cost' && item.row.unpricedTokens > 0
                ? ` + ${formatTokens(item.row.unpricedTokens)} tok`
                : ''}
            </span>
          </div>
          <svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" className="mt-0.5 h-1.5 w-full">
            <rect x="0" y="0" width="100" height="4" rx="2" fill="var(--color-muted)" />
            <rect
              x="0"
              y="0"
              width={max > 0 ? Math.max(item.value > 0 ? 1 : 0, (item.value / max) * 100) : 0}
              height="4"
              rx="2"
              fill="rgb(var(--primary-rgb) / 0.75)"
            />
          </svg>
        </li>
      ))}
    </ul>
  );
}

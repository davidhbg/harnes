import chalk from 'chalk';
import { Box, Text } from 'ink';
import type { Line, Span } from './theme.js';

/** Ein Abschnitt als fertig eingefärbter Text. */
function paint(s: Span): string {
  let c = chalk;
  if (s.color) c = c.hex(s.color);
  if (s.bg) c = c.bgHex(s.bg);
  if (s.bold) c = c.bold;
  if (s.dim) c = c.dim;
  if (s.italic) c = c.italic;
  return c(s.text);
}

/**
 * Eine Zeile aus farbigen Abschnitten. Zeilen mit vielen Abschnitten (Bilder, Verläufe) gehen
 * als ein einziger eingefärbter Text an Ink – hunderte einzelne Bausteine machen das Zeichnen
 * so langsam, dass schnell getippte Tasten zusammenkleben.
 */
export function Row({ spans }: { spans: Span[] | undefined }) {
  if (spans && spans.length > 6) return <Text wrap="truncate-end">{spans.map(paint).join('')}</Text>;
  return (
    <Text wrap="truncate-end">
      {spans && spans.length
        ? spans.map((s, j) => (
            <Text key={j} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} italic={s.italic}>
              {s.text}
            </Text>
          ))
        : ' '}
    </Text>
  );
}

/** Feste Anzahl Zeilen; fehlende werden leer aufgefüllt. */
export function Lines({ lines, height }: { lines: Line[]; height: number }) {
  const rows = [];
  for (let i = 0; i < height; i++) rows.push(<Row key={i} spans={lines[i]} />);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {rows}
    </Box>
  );
}

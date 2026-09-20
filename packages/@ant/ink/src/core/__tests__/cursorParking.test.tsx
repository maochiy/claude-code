import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import Box from '../../components/Box.js';
import Text from '../../components/Text.js';
import { useDeclaredCursor } from '../../hooks/use-declared-cursor.js';
import Ink from '../ink.js';
import { SYNC_OUTPUT_SUPPORTED } from '../terminal.js';

const inks: Ink[] = [];

afterEach(() => {
  for (const ink of inks.splice(0)) ink.unmount();
});

function createStream(columns = 20, rows = 10): NodeJS.WriteStream {
  const stream = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: true;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  return stream as unknown as NodeJS.WriteStream;
}

function createInk(): { ink: Ink; output: () => string; clear: () => void } {
  const stdout = createStream();
  const stdin = createStream() as unknown as NodeJS.ReadStream;
  const stderr = createStream();
  const chunks: string[] = [];
  stdout.on('data', chunk => chunks.push(String(chunk)));

  const ink = new Ink({
    stdout,
    stdin,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  inks.push(ink);

  return {
    ink,
    output: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
}

function DeclaredCursor({ text, column = 1 }: { text: string; column?: number }): React.ReactNode {
  const ref = useDeclaredCursor({ line: 0, column, active: true });
  return (
    <Box ref={ref}>
      <Text>{text}</Text>
    </Box>
  );
}

describe('fullscreen cursor parking', () => {
  test('parks at the declared cursor without an intermediate bottom park', () => {
    const { ink, output, clear } = createInk();
    ink.setAltScreenActive(true);
    ink.render(<DeclaredCursor text="input" />);
    ink.onRender();
    clear();

    ink.render(<DeclaredCursor text="changed" />);
    ink.onRender();

    expect(output()).not.toContain('\x1b[10;1H');
    expect(output()).toContain('\x1b[1;2H');
  });

  test('moves a declared cursor without repainting unchanged content', () => {
    const { ink, output, clear } = createInk();
    ink.setAltScreenActive(true);
    ink.render(<DeclaredCursor text="input" column={1} />);
    ink.onRender();
    clear();

    ink.render(<DeclaredCursor text="input" column={2} />);
    ink.onRender();

    const rendered = output();
    const csiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
    const printable = rendered.replace(csiSequence, '');
    expect(rendered).toContain('\x1b[1;3H');
    expect(rendered).not.toContain('\x1b[H');
    expect(rendered).not.toContain('\x1b[10;1H');
    expect(printable).toBe('');
  });

  test('avoids a HOME round trip for unsynchronized declared-cursor frames', () => {
    const { ink, output, clear } = createInk();
    ink.setAltScreenActive(true);
    ink.render(<DeclaredCursor text="input" />);
    ink.onRender();
    clear();

    ink.render(<DeclaredCursor text="changed" />);
    ink.onRender();

    if (!SYNC_OUTPUT_SUPPORTED) {
      expect(output()).not.toContain('\x1b[H');
    }
    expect(output()).not.toContain('\x1b[10;1H');
    expect(output()).toContain('\x1b[1;2H');
  });

  test('retains bottom parking when no cursor is declared', () => {
    const { ink, output, clear } = createInk();
    ink.setAltScreenActive(true);
    ink.render(<Text>first</Text>);
    clear();

    ink.render(<Text>changed</Text>);

    expect(output()).toContain('\x1b[10;1H');
  });
});

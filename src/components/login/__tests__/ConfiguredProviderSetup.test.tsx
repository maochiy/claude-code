import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { KeybindingSetup, parseBindings, wrappedRender as render, type Instance } from '@anthropic/ink';
import { AppStateProvider } from '../../../state/AppState.js';
import { DEFAULT_BINDINGS } from '../../../keybindings/defaultBindings.js';
import {
  ConfiguredProviderSetup,
  parseConfiguredModelDraft,
  removeConfiguredModel,
} from '../ConfiguredProviderSetup.js';

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.unmount();
    instance.cleanup();
  }
});

function createTTYStream(): PassThrough & {
  isTTY: true;
  isRaw: boolean;
  setRawMode(enabled: boolean): void;
  ref(): void;
  unref(): void;
  columns: number;
  rows: number;
} {
  const stream = new PassThrough() as PassThrough & {
    isTTY: true;
    isRaw: boolean;
    setRawMode(enabled: boolean): void;
    ref(): void;
    unref(): void;
    columns: number;
    rows: number;
  };
  stream.isTTY = true;
  stream.isRaw = false;
  stream.columns = 120;
  stream.rows = 40;
  stream.setRawMode = enabled => {
    stream.isRaw = enabled;
  };
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25));
}

async function writeInput(stdin: PassThrough, input: string): Promise<void> {
  stdin.write(input);
  await flush();
}

async function renderSetup(props?: {
  initialModels?: Array<{ id: string }>;
  initialDefaultModelId?: string;
  onSave?: (values: { baseUrl: string; apiKey: string; models: Array<{ id: string }>; defaultModelId: string }) => void;
}): Promise<{
  stdin: PassThrough;
  output: () => string;
}> {
  const stdin = createTTYStream();
  const stdout = createTTYStream();
  const chunks: string[] = [];
  stdout.on('data', chunk => chunks.push(String(chunk)));

  const bindings = parseBindings(DEFAULT_BINDINGS);
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup loadBindings={() => ({ bindings, warnings: [] })} subscribeToChanges={() => () => {}}>
        <ConfiguredProviderSetup
          title="Test Provider"
          initialBaseUrl=""
          initialApiKey=""
          initialModels={props?.initialModels ?? []}
          initialDefaultModelId={props?.initialDefaultModelId}
          onSave={props?.onSave ?? (() => {})}
          onCancel={() => {}}
        />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  instances.push(instance);
  await flush();
  return { stdin, output: () => chunks.join('') };
}

async function submitModel(stdin: PassThrough, modelId: string): Promise<void> {
  await writeInput(stdin, modelId);
  await writeInput(stdin, '\r');
  await writeInput(stdin, '\r');
  await writeInput(stdin, '\r');
  await writeInput(stdin, '\r');
  await writeInput(stdin, '\r');
}

describe('ConfiguredProviderSetup', () => {
  test('empty configuration enters Add Model #1 after Base URL and API Key', async () => {
    const setup = await renderSetup();

    await writeInput(setup.stdin, '\r');
    await writeInput(setup.stdin, '\r');

    expect(setup.output()).toContain('Add Model #1');
  });

  test('supports adding more than three models and saves every model', async () => {
    let saved:
      | {
          models: Array<{ id: string }>;
          defaultModelId: string;
        }
      | undefined;
    const setup = await renderSetup({
      onSave: values => {
        saved = values;
      },
    });

    await writeInput(setup.stdin, '\r');
    await writeInput(setup.stdin, '\r');

    for (let index = 1; index <= 4; index++) {
      await submitModel(setup.stdin, `model-${index}`);
      if (index < 4) {
        await writeInput(setup.stdin, '\r');
      }
    }

    expect(setup.output()).toContain('model-4');

    await writeInput(setup.stdin, '\u001B[B');
    await writeInput(setup.stdin, '\r');
    await writeInput(setup.stdin, '\r');

    expect(saved?.models.map(model => model.id)).toEqual(['model-1', 'model-2', 'model-3', 'model-4']);
    expect(saved?.defaultModelId).toBe('model-1');
  });

  test('validates required IDs, duplicate IDs, optional fields, and compact context values', () => {
    expect(
      parseConfiguredModelDraft({
        id: '',
        name: '',
        description: '',
        contextWindow: '',
        effortLevels: '',
      }).error,
    ).toBe('Model ID is required.');

    expect(
      parseConfiguredModelDraft({
        id: 'reasoning-model',
        name: '',
        description: '',
        contextWindow: '1m',
        effortLevels: 'low,high',
      }).model,
    ).toEqual({
      id: 'reasoning-model',
      contextWindow: 1_000_000,
      effortLevels: ['low', 'high'],
    });

    expect(
      parseConfiguredModelDraft({
        id: 'plain-model',
        name: '',
        description: '',
        contextWindow: '',
        effortLevels: '',
      }).model,
    ).toEqual({ id: 'plain-model' });
  });

  test('deleting the default model selects the next configured model', () => {
    expect(
      removeConfiguredModel([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }], 'model-a', 'model-a'),
    ).toEqual({
      models: [{ id: 'model-b' }, { id: 'model-c' }],
      defaultModelId: 'model-b',
    });
  });
});

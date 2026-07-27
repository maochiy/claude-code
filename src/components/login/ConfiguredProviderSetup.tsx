import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { ConfiguredModel } from '../../utils/settings/types.js';
import { Select } from '../CustomSelect/select.js';
import TextInput from '../TextInput.js';

type ConnectionField = 'base_url' | 'api_key';
type ModelField = 'id' | 'name' | 'description' | 'context_window' | 'effort_levels';
type Phase = 'connection' | 'model_form' | 'after_add' | 'model_list' | 'model_actions' | 'default_model';

export type ConfiguredModelDraft = {
  id: string;
  name: string;
  description: string;
  contextWindow: string;
  effortLevels: string;
};

type SaveValues = {
  baseUrl: string;
  apiKey: string;
  models: ConfiguredModel[];
  defaultModelId: string;
};

type Props = {
  title: string;
  description?: string;
  initialBaseUrl: string;
  initialApiKey: string;
  initialModels: ConfiguredModel[];
  initialDefaultModelId?: string;
  onSave(values: SaveValues): void;
  onCancel(): void;
};

const CONNECTION_FIELDS: ConnectionField[] = ['base_url', 'api_key'];
const MODEL_FIELDS: ModelField[] = ['id', 'name', 'description', 'context_window', 'effort_levels'];
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function emptyDraft(): ConfiguredModelDraft {
  return {
    id: '',
    name: '',
    description: '',
    contextWindow: '',
    effortLevels: '',
  };
}

function modelToDraft(model: ConfiguredModel): ConfiguredModelDraft {
  return {
    id: model.id,
    name: model.name ?? '',
    description: model.description ?? '',
    contextWindow: model.contextWindow?.toString() ?? '',
    effortLevels:
      model.effortLevels === undefined ? '' : model.effortLevels.length === 0 ? 'none' : model.effortLevels.join(','),
  };
}

function modelValueForField(draft: ConfiguredModelDraft, field: ModelField): string {
  switch (field) {
    case 'id':
      return draft.id;
    case 'name':
      return draft.name;
    case 'description':
      return draft.description;
    case 'context_window':
      return draft.contextWindow;
    case 'effort_levels':
      return draft.effortLevels;
  }
}

function parseContextWindow(rawValue: string): number | undefined {
  const normalized = rawValue.trim().replaceAll(',', '').replaceAll('_', '');
  if (!normalized) return undefined;
  const match = /^(\d+)([km])?$/i.exec(normalized);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return value * multiplier;
}

export function parseConfiguredModelDraft(draft: ConfiguredModelDraft): { model?: ConfiguredModel; error?: string } {
  const id = draft.id.trim().replace(/\[1m\]$/i, '');
  if (!id) {
    return { error: 'Model ID is required.' };
  }

  let contextWindow = parseContextWindow(draft.contextWindow);
  if (contextWindow !== undefined) {
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      return { error: 'Context Window must be a positive integer, such as 200000, 200k, or 1m.' };
    }
  } else if (/\[1m\]$/i.test(draft.id.trim())) {
    contextWindow = 1_000_000;
  }

  let effortLevels: ConfiguredModel['effortLevels'];
  const rawEffort = draft.effortLevels.trim().toLowerCase();
  if (rawEffort === 'none') {
    effortLevels = [];
  } else if (rawEffort) {
    const values = [
      ...new Set(
        rawEffort
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      ),
    ];
    const invalid = values.find(value => !EFFORT_LEVELS.has(value));
    if (invalid) {
      return {
        error: `Unsupported effort level "${invalid}". Use low, medium, high, xhigh, max, none, or leave blank.`,
      };
    }
    effortLevels = values as NonNullable<ConfiguredModel['effortLevels']>;
  }

  return {
    model: {
      id,
      ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(effortLevels !== undefined ? { effortLevels } : {}),
    },
  };
}

export function removeConfiguredModel(
  models: ConfiguredModel[],
  defaultModelId: string | undefined,
  modelId: string,
): { models: ConfiguredModel[]; defaultModelId: string | undefined } {
  const nextModels = models.filter(model => model.id !== modelId);
  return {
    models: nextModels,
    defaultModelId: defaultModelId === modelId ? nextModels[0]?.id : defaultModelId,
  };
}

export function ConfiguredProviderSetup({
  title,
  description,
  initialBaseUrl,
  initialApiKey,
  initialModels,
  initialDefaultModelId,
  onSave,
  onCancel,
}: Props): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('connection');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [connectionField, setConnectionField] = useState<ConnectionField>('base_url');
  const [connectionCursorOffset, setConnectionCursorOffset] = useState(initialBaseUrl.length);
  const [models, setModels] = useState<ConfiguredModel[]>(initialModels);
  const [defaultModelId, setDefaultModelId] = useState(initialDefaultModelId);
  const [modelField, setModelField] = useState<ModelField>('id');
  const [modelCursorOffset, setModelCursorOffset] = useState(0);
  const [modelDraft, setModelDraft] = useState<ConfiguredModelDraft>(emptyDraft);
  const [editingModelId, setEditingModelId] = useState<string>();
  const [actionModelId, setActionModelId] = useState<string>();
  const [error, setError] = useState<string>();
  const columns = Math.max(20, useTerminalSize().columns - 22);
  const previousConnectionField = useRef(connectionField);
  const previousModelField = useRef(modelField);

  useEffect(() => {
    if (previousConnectionField.current === connectionField) return;
    const value = connectionField === 'base_url' ? baseUrl : apiKey;
    setConnectionCursorOffset(value.length);
    previousConnectionField.current = connectionField;
  }, [apiKey, baseUrl, connectionField]);

  useEffect(() => {
    if (previousModelField.current === modelField) return;
    setModelCursorOffset(modelValueForField(modelDraft, modelField).length);
    previousModelField.current = modelField;
  }, [modelDraft, modelField]);

  const startAddModel = useCallback(() => {
    setEditingModelId(undefined);
    setModelDraft(emptyDraft());
    setModelField('id');
    setModelCursorOffset(0);
    previousModelField.current = 'id';
    setError(undefined);
    setPhase('model_form');
  }, []);

  const startEditModel = useCallback(
    (modelId: string) => {
      const model = models.find(candidate => candidate.id === modelId);
      if (!model) return;
      setEditingModelId(modelId);
      setModelDraft(modelToDraft(model));
      setModelField('id');
      setModelCursorOffset(model.id.length);
      previousModelField.current = 'id';
      setError(undefined);
      setPhase('model_form');
    },
    [models],
  );

  const finishConfiguration = useCallback(
    (nextModels = models, selectedDefault = defaultModelId) => {
      if (nextModels.length === 0) {
        startAddModel();
        return;
      }
      if (nextModels.length > 1 && !selectedDefault) {
        setPhase('default_model');
        return;
      }
      const resolvedDefault =
        selectedDefault && nextModels.some(model => model.id === selectedDefault) ? selectedDefault : nextModels[0]!.id;
      if (baseUrl) {
        try {
          new URL(baseUrl);
        } catch {
          setError('Invalid Base URL. Include the protocol, for example https://api.example.com/v1.');
          setPhase('connection');
          setConnectionField('base_url');
          return;
        }
      }
      onSave({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models: nextModels,
        defaultModelId: resolvedDefault,
      });
    },
    [apiKey, baseUrl, defaultModelId, models, onSave, startAddModel],
  );

  const completeModelForm = useCallback(() => {
    const parsed = parseConfiguredModelDraft(modelDraft);
    if (!parsed.model) {
      setError(parsed.error ?? 'Invalid model configuration.');
      return;
    }
    const duplicate = models.some(model => model.id === parsed.model!.id && model.id !== editingModelId);
    if (duplicate) {
      setError(`Model ID "${parsed.model.id}" is already configured.`);
      return;
    }

    const nextModels = editingModelId
      ? models.map(model => (model.id === editingModelId ? parsed.model! : model))
      : [...models, parsed.model];
    const nextDefault = defaultModelId === editingModelId ? parsed.model.id : (defaultModelId ?? parsed.model.id);
    setModels(nextModels);
    setDefaultModelId(nextDefault);
    setError(undefined);
    setPhase(editingModelId ? 'model_list' : 'after_add');
  }, [defaultModelId, editingModelId, modelDraft, models]);

  useKeybinding(
    'tabs:next',
    () => {
      const index = CONNECTION_FIELDS.indexOf(connectionField);
      if (index < CONNECTION_FIELDS.length - 1) {
        setConnectionField(CONNECTION_FIELDS[index + 1]!);
      }
    },
    { context: 'FormField', isActive: phase === 'connection' },
  );
  useKeybinding(
    'tabs:previous',
    () => {
      const index = CONNECTION_FIELDS.indexOf(connectionField);
      if (index > 0) {
        setConnectionField(CONNECTION_FIELDS[index - 1]!);
      }
    },
    { context: 'FormField', isActive: phase === 'connection' },
  );
  useKeybinding(
    'tabs:next',
    () => {
      const index = MODEL_FIELDS.indexOf(modelField);
      if (index < MODEL_FIELDS.length - 1) {
        setModelField(MODEL_FIELDS[index + 1]!);
      }
    },
    { context: 'FormField', isActive: phase === 'model_form' },
  );
  useKeybinding(
    'tabs:previous',
    () => {
      const index = MODEL_FIELDS.indexOf(modelField);
      if (index > 0) {
        setModelField(MODEL_FIELDS[index - 1]!);
      }
    },
    { context: 'FormField', isActive: phase === 'model_form' },
  );
  useKeybinding(
    'confirm:no',
    () => {
      if (phase === 'connection') {
        onCancel();
      } else if (phase === 'model_form') {
        if (models.length === 0) onCancel();
        else setPhase('model_list');
      } else if (phase === 'after_add') {
        setPhase('model_list');
      } else if (phase === 'model_actions' || phase === 'default_model') {
        setPhase('model_list');
      } else {
        setPhase('connection');
      }
    },
    { context: 'Confirmation' },
  );

  const connectionEnter = useCallback(() => {
    if (connectionField === 'base_url') {
      setConnectionField('api_key');
      return;
    }
    setError(undefined);
    if (models.length === 0) {
      startAddModel();
    } else {
      setPhase('model_list');
    }
  }, [connectionField, models.length, startAddModel]);

  const modelEnter = useCallback(() => {
    const index = MODEL_FIELDS.indexOf(modelField);
    if (index === MODEL_FIELDS.length - 1) {
      completeModelForm();
    } else {
      setModelField(MODEL_FIELDS[index + 1]!);
    }
  }, [completeModelForm, modelField]);

  const updateDraft = useCallback((field: ModelField, value: string) => {
    setModelDraft(previous => {
      switch (field) {
        case 'id':
          return { ...previous, id: value };
        case 'name':
          return { ...previous, name: value };
        case 'description':
          return { ...previous, description: value };
        case 'context_window':
          return { ...previous, contextWindow: value };
        case 'effort_levels':
          return { ...previous, effortLevels: value };
      }
    });
  }, []);

  const modelValue = useMemo(() => modelValueForField(modelDraft, modelField), [modelDraft, modelField]);

  const renderConnectionRow = (field: ConnectionField, label: string, mask = false) => {
    const active = connectionField === field;
    const value = field === 'base_url' ? baseUrl : apiKey;
    return (
      <Box>
        <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
          {` ${label} `}
        </Text>
        <Text> </Text>
        {active ? (
          <TextInput
            value={value}
            onChange={field === 'base_url' ? setBaseUrl : setApiKey}
            onSubmit={connectionEnter}
            columns={columns}
            mask={mask ? '*' : undefined}
            focus={true}
            cursorOffset={connectionCursorOffset}
            onChangeCursorOffset={setConnectionCursorOffset}
          />
        ) : value ? (
          <Text color="success">
            {mask ? value.slice(0, 8) + '\u00b7'.repeat(Math.max(0, value.length - 8)) : value}
          </Text>
        ) : null}
      </Box>
    );
  };

  const renderModelRow = (field: ModelField, label: string) => {
    const active = modelField === field;
    let value = '';
    switch (field) {
      case 'id':
        value = modelDraft.id;
        break;
      case 'name':
        value = modelDraft.name;
        break;
      case 'description':
        value = modelDraft.description;
        break;
      case 'context_window':
        value = modelDraft.contextWindow;
        break;
      case 'effort_levels':
        value = modelDraft.effortLevels;
        break;
    }
    return (
      <Box>
        <Text backgroundColor={active ? 'suggestion' : undefined} color={active ? 'inverseText' : undefined}>
          {` ${label} `}
        </Text>
        <Text> </Text>
        {active ? (
          <TextInput
            value={modelValue}
            onChange={value => updateDraft(field, value)}
            onSubmit={modelEnter}
            columns={columns}
            focus={true}
            cursorOffset={modelCursorOffset}
            onChangeCursorOffset={setModelCursorOffset}
          />
        ) : value ? (
          <Text color="success">{value}</Text>
        ) : (
          <Text dimColor>optional</Text>
        )}
      </Box>
    );
  };

  if (phase === 'connection') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{title}</Text>
        {description && <Text dimColor>{description}</Text>}
        <Box flexDirection="column" gap={1}>
          {renderConnectionRow('base_url', 'Base URL ')}
          {renderConnectionRow('api_key', 'API Key  ', true)}
        </Box>
        {error && <Text color="error">{error}</Text>}
        <Text dimColor>
          ↑↓/Tab to switch · Enter to continue · Esc to go back · {models.length} model
          {models.length === 1 ? '' : 's'} configured
        </Text>
      </Box>
    );
  }

  if (phase === 'model_form') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{editingModelId ? 'Edit Model' : `Add Model #${models.length + 1}`}</Text>
        <Box flexDirection="column" gap={1}>
          {renderModelRow('id', 'Model ID       ')}
          {renderModelRow('name', 'Name           ')}
          {renderModelRow('description', 'Description    ')}
          {renderModelRow('context_window', 'Context Window ')}
          {renderModelRow('effort_levels', 'Effort Levels  ')}
        </Box>
        {error && <Text color="error">{error}</Text>}
        <Text dimColor>
          ↑↓/Tab to switch · Enter on last field to save · context accepts 200k/1m · blank effort = all · none =
          unsupported · Esc to cancel
        </Text>
      </Box>
    );
  }

  if (phase === 'after_add') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="success">Model added successfully.</Text>
        <Select
          options={[
            { value: 'add', label: 'Add another model' },
            { value: 'finish', label: 'Finish configuration' },
            { value: 'manage', label: 'Edit configured models' },
          ]}
          onChange={value => {
            if (value === 'add') startAddModel();
            else if (value === 'finish') {
              if (models.length > 1) setPhase('default_model');
              else finishConfiguration();
            } else setPhase('model_list');
          }}
          onCancel={() => setPhase('model_list')}
        />
      </Box>
    );
  }

  if (phase === 'model_actions') {
    const selected = models.find(model => model.id === actionModelId);
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{selected?.name ?? selected?.id ?? 'Model'}</Text>
        <Select
          options={[
            { value: 'edit', label: 'Edit' },
            { value: 'default', label: 'Set as default' },
            { value: 'delete', label: 'Delete' },
            { value: 'back', label: 'Back' },
          ]}
          onChange={value => {
            if (!actionModelId) return;
            if (value === 'edit') {
              startEditModel(actionModelId);
            } else if (value === 'default') {
              setDefaultModelId(actionModelId);
              setPhase('model_list');
            } else if (value === 'delete') {
              const result = removeConfiguredModel(models, defaultModelId, actionModelId);
              setModels(result.models);
              setDefaultModelId(result.defaultModelId);
              if (result.models.length === 0) startAddModel();
              else setPhase('model_list');
            } else {
              setPhase('model_list');
            }
          }}
          onCancel={() => setPhase('model_list')}
        />
      </Box>
    );
  }

  if (phase === 'default_model') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Select default model</Text>
        <Select
          options={models.map(model => ({
            value: model.id,
            label: model.name ? `${model.name}  ${model.id}` : model.id,
            description: model.description,
          }))}
          defaultFocusValue={defaultModelId}
          onChange={value => {
            setDefaultModelId(value);
            finishConfiguration(models, value);
          }}
          onCancel={() => setPhase('model_list')}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Configure Models</Text>
      <Select
        visibleOptionCount={8}
        options={[
          ...models.map(model => ({
            value: `model:${model.id}`,
            label: `${model.id === defaultModelId ? '* ' : ''}${model.name ?? model.id}`,
            description: model.description ?? (model.name ? model.id : undefined),
          })),
          { value: 'add', label: '+ Add another model' },
          { value: 'finish', label: 'Finish configuration' },
        ]}
        onChange={value => {
          if (value === 'add') {
            startAddModel();
          } else if (value === 'finish') {
            if (models.length > 1) setPhase('default_model');
            else finishConfiguration();
          } else if (value.startsWith('model:')) {
            setActionModelId(value.slice('model:'.length));
            setPhase('model_actions');
          }
        }}
        onCancel={() => setPhase('connection')}
      />
      <Text dimColor>* default model · ↑↓ to navigate · Enter to select · Esc to go back</Text>
    </Box>
  );
}

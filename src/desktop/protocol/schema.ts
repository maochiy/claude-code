import { DESKTOP_PROTOCOL_VERSION } from './types.js'

interface JsonSchema {
  [key: string]: unknown
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
  additionalProperties: boolean | JsonSchema = false,
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
  }
}

function payloadSchema(
  type: string,
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema {
  return objectSchema(
    {
      type: { const: type },
      ...properties,
    },
    ['type', ...required],
  )
}

const nonEmptyString: JsonSchema = { type: 'string', minLength: 1 }
const stringArray: JsonSchema = {
  type: 'array',
  items: { type: 'string' },
}
const permissionMode: JsonSchema = {
  enum: [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'dontAsk',
    'auto',
  ],
}
const runtimeError = objectSchema(
  {
    code: nonEmptyString,
    message: nonEmptyString,
    stack: { type: 'string' },
    recoverable: { type: 'boolean' },
  },
  ['code', 'message'],
)
const thinkingConfig: JsonSchema = {
  oneOf: [
    objectSchema({ type: { const: 'adaptive' } }, ['type']),
    objectSchema(
      {
        type: { const: 'enabled' },
        budgetTokens: {
          type: 'number',
          exclusiveMinimum: 0,
        },
      },
      ['type', 'budgetTokens'],
    ),
    objectSchema({ type: { const: 'disabled' } }, ['type']),
  ],
}
const environment = objectSchema(
  {
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    configDir: nonEmptyString,
  },
  ['variables', 'configDir'],
)
const sessionOptions = objectSchema(
  {
    cwd: nonEmptyString,
    runtimeSessionId: nonEmptyString,
    resume: { type: 'boolean' },
    model: nonEmptyString,
    fallbackModel: nonEmptyString,
    thinkingConfig,
    permissionMode,
    environment,
    mcpServers: { type: 'object' },
    systemPrompt: nonEmptyString,
    appendSystemPrompt: nonEmptyString,
    maxTurns: { type: 'integer', minimum: 1 },
    maxBudgetUsd: { type: 'number', minimum: 0 },
    includePartialMessages: { type: 'boolean' },
  },
  ['cwd', 'permissionMode', 'environment'],
)
const interactionResponse: JsonSchema = {
  oneOf: [
    objectSchema(
      {
        outcome: { const: 'allow' },
        updatedInput: { type: 'object' },
        alwaysAllow: { type: 'boolean' },
      },
      ['outcome'],
    ),
    objectSchema(
      {
        outcome: { const: 'deny' },
        message: nonEmptyString,
        alwaysDeny: { type: 'boolean' },
      },
      ['outcome'],
    ),
    objectSchema({ outcome: { const: 'cancel' } }, ['outcome']),
    objectSchema(
      {
        outcome: { const: 'answer' },
        answers: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              {
                type: 'array',
                items: { type: 'string' },
              },
            ],
          },
        },
      },
      ['outcome', 'answers'],
    ),
    objectSchema(
      {
        outcome: { const: 'approvePlan' },
        mode: permissionMode,
      },
      ['outcome'],
    ),
    objectSchema(
      {
        outcome: { const: 'rejectPlan' },
        feedback: nonEmptyString,
      },
      ['outcome'],
    ),
  ],
}
const sdkMessage: JsonSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: nonEmptyString,
  },
  additionalProperties: true,
}
const interactionRequest = objectSchema(
  {
    interactionId: nonEmptyString,
    toolUseId: nonEmptyString,
    input: { type: 'object' },
  },
  ['interactionId', 'toolUseId', 'input'],
)
const permissionRequest = objectSchema(
  {
    interactionId: nonEmptyString,
    toolName: nonEmptyString,
    toolUseId: nonEmptyString,
    input: { type: 'object' },
    suggestions: { type: 'array' },
  },
  ['interactionId', 'toolName', 'toolUseId', 'input'],
)
const capabilities = objectSchema(
  {
    runtimeName: { const: 'claude-code-best' },
    protocolVersion: { const: DESKTOP_PROTOCOL_VERSION },
    tools: stringArray,
    commands: stringArray,
    skills: stringArray,
    agents: stringArray,
    plugins: stringArray,
    hooks: stringArray,
    providerTypes: stringArray,
    mcpCapabilities: stringArray,
    permissionModes: {
      type: 'array',
      items: permissionMode,
    },
    sessionOperations: stringArray,
    features: stringArray,
    buildFeatureFlags: stringArray,
    transportExclusions: stringArray,
  },
  [
    'runtimeName',
    'protocolVersion',
    'tools',
    'commands',
    'skills',
    'agents',
    'plugins',
    'hooks',
    'providerTypes',
    'mcpCapabilities',
    'permissionModes',
    'sessionOperations',
    'features',
    'buildFeatureFlags',
    'transportExclusions',
  ],
)

const commandPayload: JsonSchema = {
  oneOf: [
    payloadSchema('host.initialize', {
      expectedRuntimeVersion: nonEmptyString,
    }),
    payloadSchema('host.getCapabilities'),
    payloadSchema('host.shutdown'),
    payloadSchema('session.open', { options: sessionOptions }, ['options']),
    payloadSchema('session.resume', { options: sessionOptions }, ['options']),
    payloadSchema('session.suspend'),
    payloadSchema('session.close'),
    payloadSchema('session.getState'),
    payloadSchema('session.setPermissionMode', { mode: permissionMode }, [
      'mode',
    ]),
    payloadSchema('session.compact', {
      instructions: nonEmptyString,
    }),
    payloadSchema('session.fork', {
      upToMessageUuid: nonEmptyString,
    }),
    payloadSchema('session.rewind', { messageUuid: nonEmptyString }, [
      'messageUuid',
    ]),
    payloadSchema(
      'turn.start',
      {
        prompt: nonEmptyString,
        uuid: nonEmptyString,
      },
      ['prompt'],
    ),
    payloadSchema(
      'turn.enqueue',
      {
        prompt: nonEmptyString,
        uuid: nonEmptyString,
        priority: { enum: ['now', 'next', 'later'] },
      },
      ['prompt'],
    ),
    payloadSchema('turn.interrupt', {
      prompt: nonEmptyString,
      uuid: nonEmptyString,
    }),
    payloadSchema('turn.stop'),
    payloadSchema(
      'interaction.resolve',
      {
        interactionId: nonEmptyString,
        response: interactionResponse,
      },
      ['interactionId', 'response'],
    ),
  ],
}

const eventPayload: JsonSchema = {
  oneOf: [
    payloadSchema(
      'host.ready',
      {
        runtimeVersion: nonEmptyString,
        capabilities,
      },
      ['runtimeVersion', 'capabilities'],
    ),
    payloadSchema(
      'response.success',
      {
        responseTo: nonEmptyString,
        result: {},
      },
      ['responseTo'],
    ),
    payloadSchema(
      'response.failure',
      {
        responseTo: nonEmptyString,
        error: runtimeError,
      },
      ['responseTo', 'error'],
    ),
    payloadSchema(
      'session.stateChanged',
      {
        state: {
          enum: [
            'cold',
            'starting',
            'ready',
            'busy',
            'suspended',
            'crashed',
            'closed',
          ],
        },
        runtimeSessionId: nonEmptyString,
      },
      ['state'],
    ),
    payloadSchema('runtime.message', { message: sdkMessage }, ['message']),
    payloadSchema(
      'runtime.progress',
      {
        phase: nonEmptyString,
        detail: nonEmptyString,
        data: { type: 'object' },
      },
      ['phase'],
    ),
    payloadSchema(
      'interaction.permissionRequested',
      { request: permissionRequest },
      ['request'],
    ),
    payloadSchema(
      'interaction.askUserRequested',
      { request: interactionRequest },
      ['request'],
    ),
    payloadSchema(
      'interaction.planApprovalRequested',
      { request: interactionRequest },
      ['request'],
    ),
    payloadSchema('turn.completed', { result: sdkMessage }),
    payloadSchema('turn.failed', { error: runtimeError }, ['error']),
    payloadSchema(
      'worker.crashed',
      {
        exitCode: {
          type: ['integer', 'null'],
        },
        signal: {
          type: ['string', 'null'],
        },
        recoverable: { type: 'boolean' },
      },
      ['exitCode', 'signal', 'recoverable'],
    ),
    payloadSchema(
      'runtime.credentialsUpdated',
      {
        provider: { const: 'openai-codex' },
        credentials: objectSchema(
          {
            access: nonEmptyString,
            refresh: nonEmptyString,
            expires: { type: 'number' },
            accountId: nonEmptyString,
          },
          ['access', 'refresh', 'expires'],
        ),
      },
      ['provider', 'credentials'],
    ),
    payloadSchema(
      'runtime.log',
      {
        level: { enum: ['debug', 'info', 'warn', 'error'] },
        message: nonEmptyString,
      },
      ['level', 'message'],
    ),
  ],
}

function envelopeSchema(payload: JsonSchema): JsonSchema {
  return objectSchema(
    {
      protocolVersion: { const: DESKTOP_PROTOCOL_VERSION },
      requestId: nonEmptyString,
      sessionId: nonEmptyString,
      sequence: { type: 'integer', minimum: 0 },
      timestamp: { type: 'number' },
      payload,
    },
    ['protocolVersion', 'requestId', 'timestamp', 'payload'],
  )
}

export const DESKTOP_PROTOCOL_JSON_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Claude Code Best Desktop Runtime Protocol',
  oneOf: [envelopeSchema(commandPayload), envelopeSchema(eventPayload)],
}

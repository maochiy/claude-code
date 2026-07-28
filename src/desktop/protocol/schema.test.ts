import { describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { DESKTOP_PROTOCOL_JSON_SCHEMA } from './schema.js'
import { DESKTOP_PROTOCOL_VERSION } from './types.js'

const validate = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(DESKTOP_PROTOCOL_JSON_SCHEMA)

describe('Desktop Runtime protocol JSON Schema', () => {
  test('完整 command union 可通过 Schema', () => {
    expect(
      validate({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: 'request-1',
        sessionId: 'session-1',
        timestamp: Date.now(),
        payload: {
          type: 'turn.start',
          prompt: 'hello',
        },
      }),
    ).toBe(true)
  })

  test('Skill Catalog command 可通过 Schema', () => {
    expect(
      validate({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: 'request-skill-catalog',
        sessionId: 'skill-catalog-session',
        timestamp: Date.now(),
        payload: {
          type: 'session.resolveSkillCatalog',
          options: {
            cwd: '/tmp/project',
            additionalSkillDirectories: ['/tmp/proma-skills'],
            permissionMode: 'default',
            environment: { variables: {}, configDir: '/tmp/ccb' },
          },
        },
      }),
    ).toBe(true)
  })

  test('未知 payload type 被 Schema 拒绝', () => {
    expect(
      validate({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: 'request-1',
        timestamp: Date.now(),
        payload: {
          type: 'unknown.command',
        },
      }),
    ).toBe(false)
  })

  test('缺少 command 必填字段被 Schema 拒绝', () => {
    expect(
      validate({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: 'request-1',
        sessionId: 'session-1',
        timestamp: Date.now(),
        payload: {
          type: 'session.rewind',
        },
      }),
    ).toBe(false)
  })

  test('完整 event union 可通过 Schema', () => {
    expect(
      validate({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: 'event-1',
        sessionId: 'session-1',
        sequence: 1,
        timestamp: Date.now(),
        payload: {
          type: 'worker.crashed',
          exitCode: 1,
          signal: null,
          recoverable: false,
        },
      }),
    ).toBe(true)
  })
})

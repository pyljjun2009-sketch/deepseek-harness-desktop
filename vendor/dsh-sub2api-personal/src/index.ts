import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeSub2Api } from './core.js'
import type { Sub2ApiArgs } from './core.js'

export { executeSub2Api, redactSensitiveText, version } from './core.js'
export type { Sub2ApiAction, Sub2ApiArgs, Sub2ApiResult } from './core.js'

export const name = 'sub2api-personal'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'sub2api_personal',
    description: 'Use a user-selected local Sub2API profile. Supports profile listing, connection test, model discovery, local usage summary, and one OpenAI-compatible JSON request. Never use it without a profile explicitly named by the user for quota-consuming requests.',
    parameters: {
      action: {
        type: 'string', enum: ['list_profiles', 'test_profile', 'models', 'usage', 'invoke'], required: true,
        description: 'The safe operation to run. list_profiles is read-only. invoke consumes the selected profile quota.',
      },
      profileName: { type: 'string', description: 'Exact locally configured profile name. Required for test_profile, models, and invoke; optional for usage.' },
      path: { type: 'string', enum: ['chat/completions', 'responses'], description: 'For invoke only: the supported OpenAI-compatible inference route.' },
      bodyJson: { type: 'string', description: 'For invoke only: valid JSON request body. It is written to a temporary file, never passed as a shell argument, and is deleted after the request.' },
      stream: { type: 'boolean', description: 'For invoke only: request SSE from the local client. bodyJson.stream must match.' },
      days: { type: 'integer', description: 'For usage only: number of days to summarize, 1 to 3650. Defaults to 30.' },
      timeoutSec: { type: 'integer', description: 'For invoke only: request timeout in seconds, 1 to 900. Defaults to 120.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the client command completed successfully.' },
          action: { type: 'string', required: true, description: 'The executed operation.' },
          profileName: { type: 'string', required: true, description: 'Selected profile name, if applicable.' },
          data: { type: 'string', required: true, description: 'Gateway or local-client output. Secrets are not included.' },
          error: { type: 'string', required: true, description: 'Redacted failure information, if any.' },
          exitCode: { type: 'integer', required: true, description: 'Underlying local-client process exit code.' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 910_000,
    isConcurrencySafe: (args) => args.action === 'list_profiles' || args.action === 'models' || args.action === 'usage',
    async execute(args) { return executeSub2Api(args as Sub2ApiArgs) },
  }))
  console.log(`[sub2api-personal] registered "sub2api_personal" — listed=${ctx.tools.get('sub2api_personal') !== undefined}`)
}

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export const version = '0.4.2'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_OUTPUT_CHARS = 60_000
const MAX_CAPTURE_CHARS = MAX_OUTPUT_CHARS + 4_096
const TRUNCATION_MARKER = '\n[output truncated by dsh-sub2api-personal]'
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
export type Sub2ApiAction = 'list_profiles' | 'test_profile' | 'models' | 'usage' | 'invoke'
export type Sub2ApiArgs = {
  action: Sub2ApiAction
  profileName?: string
  path?: 'chat/completions' | 'responses'
  bodyJson?: string
  stream?: boolean
  days?: number
  timeoutSec?: number
}
export type Sub2ApiResult = {
  ok: boolean
  action: Sub2ApiAction
  profileName: string
  data: string
  error: string
  exitCode: number
}

function clientPath() {
  const configured = process.env.SUB2API_PERSONAL_CLIENT_PATH
  if (configured) return configured
  const userHome = process.env.USERPROFILE ?? process.env.HOME
  return userHome ? join(userHome, 'plugins', 'sub2api-personal', 'scripts', 'sub2api.ps1') : ''
}
function isJsonObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isValidProfileName(value: string) { return PROFILE_NAME_PATTERN.test(value) }
function configuredProfileAllowlist() {
  const raw = process.env.SUB2API_PERSONAL_ALLOWED_PROFILES
  if (raw === undefined) return undefined
  const names = raw.split(',').map((value) => value.trim()).filter(Boolean)
  if (names.some((value) => !isValidProfileName(value))) throw new Error('SUB2API_PERSONAL_ALLOWED_PROFILES contains an invalid profile name.')
  return new Set(names)
}
function normalizeProfileList(value: string, allowlist: Set<string> | undefined) {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('The local client returned an invalid profile list.') }
  if (!Array.isArray(parsed)) throw new Error('The local client returned an invalid profile list.')
  const profiles = parsed.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.name !== 'string' || !isValidProfileName(entry.name)) throw new Error('The local client returned an invalid profile list.')
    return { name: entry.name }
  })
  if (new Set(profiles.map(({ name }) => name)).size !== profiles.length) throw new Error('The local client returned duplicate profile names.')
  return JSON.stringify(allowlist === undefined ? profiles : profiles.filter(({ name }) => allowlist.has(name)))
}

export function redactSensitiveText(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/(authorization\s*:\s*)(bearer|basic)\s+[^\s,;"']+/gi, '$1$2 [REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|(?:client|refresh|session)[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|access[_-]?token|(?:client|refresh|session)[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password)"\s*:\s*")((?:\\.|[^"\\])*)"/gi, '$1[REDACTED]"')
    .replace(/('(?:api[_-]?key|access[_-]?token|(?:client|refresh|session)[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password)'\s*[:=]\s*')((?:\\.|[^'\\])*)'/gi, "$1[REDACTED]'")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|(?:client|refresh|session)[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s,"'}\]]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}
function clip(value: string, maxChars = MAX_OUTPUT_CHARS) {
  if (maxChars <= 0) return ''
  const redacted = redactSensitiveText(value).trim()
  if (redacted.length <= maxChars) return redacted
  if (maxChars <= TRUNCATION_MARKER.length) return ''
  return `${redacted.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`
}
function appendCapped(value: string, chunk: string) {
  if (value.length >= MAX_CAPTURE_CHARS) return value
  return value + chunk.slice(0, MAX_CAPTURE_CHARS - value.length)
}

async function runPowerShell(args: string[], timeoutSec: number, signal?: AbortSignal): Promise<CommandResult> {
  if (signal?.aborted) return { exitCode: 1, stdout: '', stderr: 'The Sub2API request was cancelled by the host.', timedOut: false }
  const script = clientPath()
  if (!script) return { exitCode: 1, stdout: '', stderr: 'SUB2API_PERSONAL_CLIENT_PATH is not set and no user home directory is available.', timedOut: false }
  try { await access(script) } catch {
    return { exitCode: 1, stdout: '', stderr: `Sub2API client was not found at: ${script}. Install/configure sub2api-personal first, or set SUB2API_PERSONAL_CLIENT_PATH.`, timedOut: false }
  }
  return await new Promise((resolveResult) => {
    const executable = process.env.SUB2API_PERSONAL_POWERSHELL_PATH || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script, ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let forcedResult: CommandResult | undefined
    let killGraceTimer: NodeJS.Timeout | undefined
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killGraceTimer) clearTimeout(killGraceTimer)
      signal?.removeEventListener('abort', onAbort)
      resolveResult(result)
    }
    const stop = (result: CommandResult) => {
      if (settled || forcedResult) return
      forcedResult = result
      child.kill()
      killGraceTimer = setTimeout(() => finish(result), 2_000)
      killGraceTimer.unref()
    }
    const onAbort = () => stop({ exitCode: 1, stdout, stderr: `${stderr}\nThe Sub2API request was cancelled by the host.`, timedOut: false })
    const timer = setTimeout(() => stop({ exitCode: 1, stdout, stderr: `${stderr}\nThe Sub2API request timed out after ${timeoutSec} seconds.`, timedOut: true }), timeoutSec * 1000)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = appendCapped(stdout, chunk) })
    child.stderr.on('data', (chunk: string) => { stderr = appendCapped(stderr, chunk) })
    child.on('error', (error) => finish(forcedResult ?? { exitCode: 1, stdout, stderr: `${stderr}\nFailed to start PowerShell: ${error.message}`, timedOut: false }))
    child.on('close', (code) => finish(forcedResult ?? { exitCode: code ?? 1, stdout, stderr, timedOut: false }))
  })
}

export async function executeSub2Api(args: Sub2ApiArgs, signal?: AbortSignal): Promise<Sub2ApiResult> {
  const profileName = args.profileName ?? ''
  const invalid = (message: string): Sub2ApiResult => ({ ok: false, action: args.action, profileName, data: '', error: message, exitCode: 2 })
  if (['test_profile', 'models', 'invoke'].includes(args.action) && !profileName) return invalid('profileName is required for this action.')
  if (profileName && !isValidProfileName(profileName)) return invalid('profileName must match a configured Sub2API profile name (1–64 letters, numbers, dot, underscore, or hyphen; it must start with a letter or number).')
  if (args.action === 'invoke' && !args.path) return invalid('path is required for invoke.')
  if (args.action === 'invoke' && !['chat/completions', 'responses'].includes(args.path!)) return invalid('path must be chat/completions or responses.')

  let temporaryDirectory = ''
  try {
    const allowlist = configuredProfileAllowlist()
    if (allowlist !== undefined && profileName && !allowlist.has(profileName)) return invalid(`Profile "${profileName}" is not allowed for this process.`)
    if (allowlist !== undefined && args.action === 'usage' && !profileName) return invalid('profileName is required for usage when SUB2API_PERSONAL_ALLOWED_PROFILES is configured.')
    const timeoutSec = args.timeoutSec ?? 120
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 900) return invalid('timeoutSec must be an integer from 1 through 900.')
    const command: string[] = []
    switch (args.action) {
      case 'list_profiles': command.push('list-profiles'); break
      case 'test_profile': command.push('test-profile', '-ProfileName', profileName); break
      case 'models': command.push('models', '-ProfileName', profileName); break
      case 'usage': {
        const days = args.days ?? 30
        if (!Number.isInteger(days) || days < 1 || days > 3650) return invalid('days must be an integer from 1 through 3650.')
        command.push('usage', '-Days', String(days))
        if (profileName) command.push('-ProfileName', profileName)
        break
      }
      case 'invoke': {
        if (!args.bodyJson) return invalid('bodyJson is required for invoke requests.')
        let requestBody: unknown
        try { requestBody = JSON.parse(args.bodyJson) } catch { return invalid('bodyJson must be valid JSON.') }
        if (!isJsonObject(requestBody)) return invalid('bodyJson must be a JSON object.')
        if ('stream' in requestBody && typeof requestBody.stream !== 'boolean') return invalid('bodyJson.stream must be a boolean when provided.')
        if ((requestBody.stream === true) !== (args.stream === true)) return invalid('stream must match bodyJson.stream exactly; set both to true for SSE or omit/false for a non-streaming response.')
        if (Buffer.byteLength(args.bodyJson, 'utf8') > MAX_BODY_BYTES) return invalid('bodyJson exceeds the 1 MiB safety limit.')
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-sub2api-'))
        const bodyPath = join(temporaryDirectory, 'request.json')
        await writeFile(bodyPath, args.bodyJson, { encoding: 'utf8', mode: 0o600 })
        command.push('invoke', '-ProfileName', profileName, '-Path', args.path!, '-TimeoutSec', String(timeoutSec), '-BodyFile', bodyPath)
        if (args.stream) command.push('-Stream')
      }
    }
    const result = await runPowerShell(command, timeoutSec, signal)
    const rawData = args.action === 'list_profiles' && result.exitCode === 0 ? normalizeProfileList(result.stdout, allowlist) : result.stdout
    let data: string
    let error: string
    if (result.exitCode === 0) {
      data = clip(rawData)
      error = clip(result.stderr, MAX_OUTPUT_CHARS - data.length)
    } else {
      error = clip(result.stderr)
      data = clip(rawData, MAX_OUTPUT_CHARS - error.length)
    }
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      temporaryDirectory = ''
    }
    return { ok: result.exitCode === 0, action: args.action, profileName, data, error: result.timedOut ? error || 'Request timed out.' : error, exitCode: result.exitCode }
  } catch (error) {
    return { ok: false, action: args.action, profileName, data: '', error: error instanceof Error ? redactSensitiveText(error.message) : redactSensitiveText(String(error)), exitCode: 1 }
  } finally {
    if (temporaryDirectory) {
      try { await rm(temporaryDirectory, { recursive: true, force: true }) } catch { /* best effort after returning a structured failure */ }
    }
  }
}

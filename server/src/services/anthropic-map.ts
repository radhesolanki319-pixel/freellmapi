import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';

// Claude Code model mapping. Claude Code keeps its built-in model names
// (e.g. `claude-sonnet-4-5` as the main model, `claude-3-5-haiku` as the
// small/fast background model) and sends them verbatim to `/v1/messages`.
// Since this proxy serves a free model pool (not the real Claude cloud
// models), we map each Claude family to either "auto" (let the router pick —
// the default and the common case) or a specific catalog model the operator
// pins. A concrete catalog model id sent directly (e.g. the user set
// ANTHROPIC_MODEL to one of our models) bypasses the map and pins as-is.
//
// Stored as a JSON blob in the `settings` table — no migration needed.

const SETTING_KEY = 'anthropic_model_map';

export const CLAUDE_FAMILIES = ['default', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];
// Each value is either the sentinel 'auto' or a catalog model_id.
export type AnthropicModelMap = Record<ClaudeFamily, string>;

const DEFAULT_MAP: AnthropicModelMap = { default: 'auto', opus: 'auto', sonnet: 'auto', haiku: 'auto' };

export const anthropicModelMapSchema = z.object({
  default: z.string().min(1).optional(),
  opus: z.string().min(1).optional(),
  sonnet: z.string().min(1).optional(),
  haiku: z.string().min(1).optional(),
}).strict();

export function getClaudeModelMap(): AnthropicModelMap {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return { ...DEFAULT_MAP };
  try {
    const p = JSON.parse(raw) as Partial<AnthropicModelMap>;
    return {
      default: typeof p.default === 'string' && p.default ? p.default : 'auto',
      opus: typeof p.opus === 'string' && p.opus ? p.opus : 'auto',
      sonnet: typeof p.sonnet === 'string' && p.sonnet ? p.sonnet : 'auto',
      haiku: typeof p.haiku === 'string' && p.haiku ? p.haiku : 'auto',
    };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export function setClaudeModelMap(input: unknown): AnthropicModelMap {
  const patch = anthropicModelMapSchema.parse(input);
  const current = getClaudeModelMap();
  const next: AnthropicModelMap = {
    default: patch.default ?? current.default,
    opus: patch.opus ?? current.opus,
    sonnet: patch.sonnet ?? current.sonnet,
    haiku: patch.haiku ?? current.haiku,
  };
  setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

// Classify a requested model into a Claude family, or null when it's not a
// Claude alias at all (a concrete catalog id meant to pin directly).
export function classifyClaudeFamily(model?: string): ClaudeFamily | null {
  const m = (model ?? '').trim().toLowerCase();
  if (!m || m === 'auto' || m === 'default' || m === 'freellmapi-auto') return 'default';
  // Claude Code's planning alias is opus-ish by name but must hit the catch-all,
  // so match it before the substring family checks below.
  if (m === 'opusplan' || m === 'opusplan-4') return 'default';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  // Any other claude-ish alias → the catch-all.
  if (m.startsWith('claude')) return 'default';
  return null;
}

export interface ResolvedAnthropicModel {
  // The catalog model db id to pin, or undefined to auto-route.
  preferredModelDbId?: number;
  // The catalog model_id that db id belongs to, when one was pinned. Callers
  // widen this into the model's cross-provider group so a failure fails over to
  // the SAME model on another provider (the strict chain /v1/chat/completions
  // and /v1/responses already build) instead of to an unrelated model.
  modelId?: string;
  // True when we resolved to a specific model (for analytics/pinned labels).
  pinned: boolean;
}

// Resolve the model a `/v1/messages` request should route to, honoring the
// operator's family map. Returns undefined preferredModelDbId to mean
// "auto-route" (the default for every family unless the operator pinned one).
export function resolveAnthropicModel(model?: string): ResolvedAnthropicModel {
  const db = getDb();
  // A model_id can exist on several platforms at once (the same open-weights
  // model relayed by two providers). The row we pin is only the head hint —
  // the caller routes over the whole group — but an arbitrary SQLite row order
  // made the head flap between providers run to run, so pick deterministically:
  // chain priority first (ascending, as everywhere else), then insertion order.
  const lookupEnabled = (modelId: string): { id: number; model_id: string } | undefined =>
    db.prepare(`
      SELECT m.id as id, m.model_id as model_id
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ? AND m.enabled = 1
      ORDER BY COALESCE(fc.priority, 0) ASC, m.id ASC
      LIMIT 1
    `).get(modelId) as { id: number; model_id: string } | undefined;

  const family = classifyClaudeFamily(model);
  if (family) {
    const target = getClaudeModelMap()[family];
    if (!target || target === 'auto') return { pinned: false };
    const row = lookupEnabled(target);
    // A pinned-but-now-disabled/removed target degrades gracefully to auto.
    return row ? { preferredModelDbId: row.id, modelId: row.model_id, pinned: true } : { pinned: false };
  }

  // Not a Claude alias: treat as a concrete catalog model id and pin it if it
  // exists and is enabled; otherwise auto-route (lenient, like the OpenAI route).
  const row = lookupEnabled((model ?? '').trim());
  return row ? { preferredModelDbId: row.id, modelId: row.model_id, pinned: true } : { pinned: false };
}

// The canonical Claude id this gateway answers to for each family, and the
// label discovery shows for it.
//
// These are NOT real Claude cloud models and are not presented as such: every
// one of them is already accepted by `/v1/messages`, where classifyClaudeFamily
// maps it onto the free pool through the operator's family map. They are listed
// in `GET /v1/models` because some Anthropic clients only accept ids that look
// like Claude models and reject a catalog of free-model ids outright. Claude
// Desktop's third-party gateway picker is the reported case (#880): it fetched
// the full catalog over HTTP 200 and still reported "found 0 models", because
// nothing in it belonged to a Claude family.
//
// Listing them is honest in the sense that matters for discovery: these are ids
// the gateway really will serve. The display name says where the request
// actually goes so nobody reads the entry as hosted Claude.
export const CLAUDE_FAMILY_ALIASES: { id: string; family: ClaudeFamily; label: string }[] = [
  { id: 'claude-fable-5.1', family: 'default', label: 'Claude Fable 5.1' },
  { id: 'claude-haiku-4.5-20251001-r', family: 'haiku', label: 'Claude Haiku 4.5 (20251001-R)' },
  { id: 'claude-haiku-5.5', family: 'haiku', label: 'Claude Haiku 5.5' },
  { id: 'claude-opus-5', family: 'opus', label: 'Claude Opus 5' },
  { id: 'claude-opus-5.5', family: 'opus', label: 'Claude Opus 5.5' },
  { id: 'claude-opus-5.5-fast', family: 'opus', label: 'Claude Opus 5.5 Fast' },
  { id: 'claude-sonnet-5.5', family: 'sonnet', label: 'Claude Sonnet 5.5' },
  { id: 'claude-fable-5', family: 'default', label: 'Claude Fable 5' },
  { id: 'claude-opus-4.8-fast', family: 'opus', label: 'Claude Opus 4.8 Fast' },
  { id: 'claude-opus-4.8', family: 'opus', label: 'Claude Opus 4.8' },
  { id: 'claude-opus-4.7', family: 'opus', label: 'Claude Opus 4.7' },
  { id: 'claude-opus-4.6', family: 'opus', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-5', family: 'sonnet', label: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4.6', family: 'sonnet', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4.5', family: 'haiku', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4.5', family: 'opus', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4.5', family: 'sonnet', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-5-fast', family: 'opus', label: 'Claude Opus 5 Fast' },
  { id: 'claude-mythos-preview', family: 'default', label: 'Claude Mythos Preview' },
  { id: 'claude-opus-4-5', family: 'opus', label: 'Opus' },
  { id: 'claude-sonnet-4-5', family: 'sonnet', label: 'Sonnet' },
  { id: 'claude-haiku-4-5', family: 'haiku', label: 'Haiku' },
];

export interface FlagshipModelDef {
  id: string;
  name: string;
  ownedBy: string;
  family: string;
  contextWindow: number;
  target: string;
  isClaudeFamily?: boolean;
}

export const RADHE_FLAGSHIP_ROSTER: FlagshipModelDef[] = [
  { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-haiku-4.5-20251001-r', name: 'Claude Haiku 4.5 (20251001-R)', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-5.5-fast', name: 'Claude Opus 5.5 Fast', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'gemini-3.5-transcribe-live', name: 'Gemini 3.5 Transcribe Live', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'auto' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.8-flash' },
  { id: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash-Lite TTS', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'auto' },
  { id: 'gemini-3.8-live-extended-thinking', name: 'Gemini 3.8 Live Extended Thinking', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'auto' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'auto' },
  { id: 'gemini-omni-flash-preview', name: 'Gemini Omni Flash Preview', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'auto' },
  { id: 'glm-4.7-flashx', name: 'GLM 4.7 Flashx', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'auto' },
  { id: 'glm-5-turbo', name: 'GLM 5 Turbo', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'auto' },
  { id: 'glm-5.3-flashx', name: 'GLM 5.3 Flashx', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'auto' },
  { id: 'gpt-5.1-codex', name: 'GPT 5.1 Codex', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.1-codex-max', name: 'GPT 5.1 Codex Max', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.1-thinking-fast', name: 'GPT 5.1 Thinking Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.3-codex-fast', name: 'GPT 5.3 Codex Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.4-mini-fast', name: 'GPT 5.4 Mini Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.5-fast', name: 'GPT 5.5 Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-luna-fast', name: 'GPT 5.6 Luna Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-sol-fast', name: 'GPT 5.6 Sol Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-terra-fast', name: 'GPT 5.6 Terra Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-sol-pro', name: 'GPT 5.6 Sol Pro', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-astra-fast', name: 'GPT 6 Astra Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-luna', name: 'GPT 6 Luna', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-luna-decisions', name: 'GPT 6 Luna Decisions', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-luna-fast', name: 'GPT 6 Luna Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-luna-pro', name: 'GPT 6 Luna Pro', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-sol', name: 'GPT 6 Sol', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6-sol-fast', name: 'GPT 6 Sol Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-6.1-sol-fast', name: 'GPT 6.1 Sol Fast', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-realtime-whisper', name: 'GPT Realtime Whisper', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-realtime-mini', name: 'GPT Realtime Mini', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'grok-4.20-multi-agent', name: 'Grok 4.20 Multi Agent', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.20-beta', name: 'Grok 4.20 Beta', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.20-multi-agent-beta', name: 'Grok 4.20 Multi Agent Beta', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.20-non-reasoning', name: 'Grok 4.20 Non Reasoning', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.20-reasoning', name: 'Grok 4.20 Reasoning', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.3', name: 'Grok 4.3', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.6', name: 'Grok 4.6', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.7', name: 'Grok 4.7', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-code-fast-1', name: 'Grok Code Fast 1', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-imagine-image-2.0', name: 'Grok Imagine Image 2.0', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-imagine-quality', name: 'Grok Imagine Quality', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-imagine-video', name: 'Grok Imagine Video', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-stt', name: 'Grok STT', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-tts', name: 'Grok TTS', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-voice-3.0', name: 'Grok Voice 3.0', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'grok-voice-think-fast-2.0', name: 'Grok Voice Think Fast 2.0', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code Highspeed', ownedBy: 'moonshot', family: 'Kimi', contextWindow: 200000, target: 'auto' },
  { id: 'kimi-k3-fast', name: 'Kimi K3 Fast', ownedBy: 'moonshot', family: 'Kimi', contextWindow: 200000, target: 'auto' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', ownedBy: 'moonshot', family: 'Kimi', contextWindow: 200000, target: 'auto' },
  { id: 'kimi-k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed', ownedBy: 'moonshot', family: 'Kimi', contextWindow: 200000, target: 'auto' },
  { id: 'tts-gemini-3-1-flash', name: 'Gemini 3.1 Flash TTS', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'auto' },
  { id: 'veo-3.1-fast-generate-001', name: 'Veo 3.1 Fast Generate', ownedBy: 'google', family: 'Veo', contextWindow: 128000, target: 'auto' },
  { id: 'veo-3.1-generate-001', name: 'Veo 3.1 Generate', ownedBy: 'google', family: 'Veo', contextWindow: 128000, target: 'auto' },
  { id: 'veo-3.1-lite-generate-001', name: 'Veo 3.1 Lite Generate', ownedBy: 'google', family: 'Veo', contextWindow: 128000, target: 'auto' },
  { id: 'voxtral-mini-tts-3', name: 'Voxtral Mini TTS 3', ownedBy: 'mistral', family: 'Mistral', contextWindow: 128000, target: 'auto' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'glm-5.2', name: 'GLM 5.2', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'z-ai/glm-5.2' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'kimi-k3', name: 'Kimi K3', ownedBy: 'moonshot', family: 'Kimi', contextWindow: 200000, target: 'auto' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'claude-opus-4.8-fast', name: 'Claude Opus 4.8 Fast', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'nano-banana', name: 'Nano Banana', ownedBy: 'google', family: 'NanoBanana', contextWindow: 1048576, target: 'auto' },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'gpt-5.5', name: 'GPT-5.5', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.4', name: 'GPT 5.4', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'grok-imagine-image', name: 'Grok Imagine Image', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'nano-banana-pro', name: 'Nano Banana Pro', ownedBy: 'google', family: 'NanoBanana', contextWindow: 1048576, target: 'auto' },
  { id: 'nano-banana-2', name: 'Nano Banana 2', ownedBy: 'google', family: 'NanoBanana', contextWindow: 1048576, target: 'auto' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', ownedBy: 'minimax', family: 'MiniMax', contextWindow: 200000, target: 'auto' },
  { id: 'grok-4.5', name: 'Grok 4.5', ownedBy: 'xai', family: 'Grok', contextWindow: 200000, target: 'auto' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.5-flash' },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'glm-5', name: 'GLM 5', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'auto' },
  { id: 'glm-5.1', name: 'GLM 5.1', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'auto' },
  { id: 'claude-opus-5-fast', name: 'Claude Opus 5 Fast', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.6-flash' },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.7-flash' },
  { id: 'elevenlabs-scribe-v2', name: 'ElevenLabs Scribe V2', ownedBy: 'elevenlabs', family: 'ElevenLabs', contextWindow: 128000, target: 'auto' },
  { id: 'glm-5.3-fast', name: 'GLM 5.3 Fast', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'auto' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.5-flash-lite' },
  { id: 'gemini-flash-latest', name: 'Gemini Flash Latest', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-flash-latest' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.8-flash' },
  { id: 'claude-mythos-preview', name: 'Claude Mythos Preview', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'glm-5.3', name: 'GLM 5.3', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'glm-5.3:free' },
  { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', ownedBy: 'alibaba', family: 'Qwen', contextWindow: 1000000, target: 'qwen/qwen3.8-max:free' },
  { id: 'qwen3.8-omni-flash', name: 'Qwen 3.8 Omni Flash', ownedBy: 'alibaba', family: 'Qwen', contextWindow: 128000, target: 'qwen/qwen3.8-omni-flash:free' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', ownedBy: 'deepseek', family: 'DeepSeek', contextWindow: 128000, target: 'deepseek-ai/DeepSeek-V4-Pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', ownedBy: 'deepseek', family: 'DeepSeek', contextWindow: 128000, target: 'DeepSeek-V4-Flash' },
];

export function resolveFlagshipModel(modelId?: string): FlagshipModelDef | null {
  if (!modelId) return null;
  const m = modelId.trim().toLowerCase();
  return RADHE_FLAGSHIP_ROSTER.find(f => f.id.toLowerCase() === m) ?? null;
}

/** What an OpenAI-wire route should dispatch a listed Claude alias to. */
export type ClaudeAliasDispatch =
  | { kind: 'model'; modelId: string }
  | { kind: 'auto' };

export function resolveListedClaudeAlias(model?: string): ClaudeAliasDispatch | null {
  const id = (model ?? '').trim().toLowerCase();
  if (!CLAUDE_FAMILY_ALIASES.some(alias => alias.id === id)) return null;
  const resolved = resolveAnthropicModel(id);
  if (resolved.modelId) return { kind: 'model', modelId: resolved.modelId };
  return { kind: 'auto' };
}

// Discovery entries for the family aliases, named after where each one routes:
// the pinned catalog model when the operator pinned one, otherwise the router.
export function claudeFamilyDiscoveryEntries(): { id: string; displayName: string }[] {
  const map = getClaudeModelMap();
  return CLAUDE_FAMILY_ALIASES.map(({ id, family, label }) => {
    const target = map[family];
    return {
      id,
      displayName: !target || target === 'auto'
        ? `${label} slot (auto-routed to a free model)`
        : `${label} slot (routed to ${target})`,
    };
  });
}

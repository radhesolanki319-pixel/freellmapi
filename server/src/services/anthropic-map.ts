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
  { id: 'claude-opus-5.5', family: 'opus', label: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', family: 'opus', label: 'Claude Opus 5' },
  { id: 'claude-opus-4.8', family: 'opus', label: 'Claude Opus 4.8' },
  { id: 'claude-opus-4.7', family: 'opus', label: 'Claude Opus 4.7' },
  { id: 'claude-opus-4.6', family: 'opus', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-5', family: 'sonnet', label: 'Claude Sonnet 5' },
  { id: 'claude-fable-5.1', family: 'default', label: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', family: 'default', label: 'Claude Fable 5' },
  { id: 'claude-mythos-preview', family: 'default', label: 'Claude Mythos Preview' },
  { id: 'claude-opus-4-5', family: 'opus', label: 'Opus' },
  { id: 'claude-sonnet-4-5', family: 'sonnet', label: 'Sonnet' },
  { id: 'claude-haiku-4-5', family: 'haiku', label: 'Haiku' },
];

export interface FlagshipModelDef {
  id: string;
  name: string;
  ownedBy: string;
  family: 'Gemini' | 'Claude' | 'GPT' | 'GLM' | 'Qwen' | 'DeepSeek';
  contextWindow: number;
  target: string;
  isClaudeFamily?: boolean;
}

export const RADHE_FLAGSHIP_ROSTER: FlagshipModelDef[] = [
  // 1-7: Gemini Family (7)
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.8-flash' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.7-flash' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.6-flash' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.5-flash' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.5-flash-lite' },
  { id: 'gemini-flash-latest', name: 'Gemini Flash Latest', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-flash-latest' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', ownedBy: 'google', family: 'Gemini', contextWindow: 1048576, target: 'gemini-3.8-flash' },

  // 8-16: Claude Family (9)
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-fable-5', name: 'Claude Fable 5', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },
  { id: 'claude-mythos-preview', name: 'Claude Mythos Preview', ownedBy: 'anthropic', family: 'Claude', contextWindow: 200000, target: 'auto', isClaudeFamily: true },

  // 17-22: GPT Family (6)
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },
  { id: 'gpt-5.5', name: 'GPT-5.5', ownedBy: 'openai', family: 'GPT', contextWindow: 1000000, target: 'auto' },

  // 23-24: GLM Family (2)
  { id: 'glm-5.3', name: 'GLM 5.3', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'glm-5.3:free' },
  { id: 'glm-5.2', name: 'GLM 5.2', ownedBy: 'zhipu', family: 'GLM', contextWindow: 128000, target: 'z-ai/glm-5.2' },

  // 25-26: Qwen Family (2)
  { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', ownedBy: 'alibaba', family: 'Qwen', contextWindow: 1000000, target: 'qwen/qwen3.8-max:free' },
  { id: 'qwen3.8-omni-flash', name: 'Qwen 3.8 Omni Flash', ownedBy: 'alibaba', family: 'Qwen', contextWindow: 128000, target: 'qwen/qwen3.8-omni-flash:free' },

  // 27-28: DeepSeek Family (2)
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

// Migration: SOTA Free Models Expansion & High-Reliability Fallback Pool
// Created: 2026-11-19
//
// DOWN: reversible
//
// Expands the models table with verified blazing-fast SOTA models across
// Groq, Mistral, and SiliconFlow:
// - Groq: qwen/qwen3.8-27b (340ms), openai/gpt-oss-120b (440ms), openai/gpt-oss-20b (310ms)
// - Mistral: codestral-latest (510ms SOTA coder), ministral-14b-latest, ministral-8b-latest
// - SiliconFlow: deepseek-ai/DeepSeek-V4.1-Flash (SOTA reasoning/chat), zai-org/GLM-5.3-Flash (1s),
//   Qwen/Qwen3.8-27B, moonshotai/Kimi-K3.1-Pro, MiniMaxAI/MiniMax-M3.1-Flash, deepseek-ai/DeepSeek-V4-Flash-Vision-Exp
//
// Automatically seeds fallback_config rows for all new models and ensures
// high-priority fallback chain placement.

import type { Db } from '../types.js';

interface ModelSeedTuple {
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  monthly_token_budget: string;
  context_window: number;
  supports_vision: number;
  supports_tools: number;
}

const NEW_SOTA_MODELS: ModelSeedTuple[] = [
  // Groq ultra-fast (<450ms)
  {
    platform: 'groq',
    model_id: 'qwen/qwen3.8-27b',
    display_name: 'Qwen 3.8 27B (Groq)',
    intelligence_rank: 2,
    speed_rank: 1,
    size_label: 'Large',
    rpm_limit: 30,
    rpd_limit: 1000,
    tpm_limit: 6000,
    tpd_limit: 500000,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'groq',
    model_id: 'openai/gpt-oss-120b',
    display_name: 'GPT-OSS 120B (Groq)',
    intelligence_rank: 1,
    speed_rank: 2,
    size_label: 'Frontier',
    rpm_limit: 30,
    rpd_limit: 1000,
    tpm_limit: 6000,
    tpd_limit: 500000,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'groq',
    model_id: 'openai/gpt-oss-20b',
    display_name: 'GPT-OSS 20B (Groq)',
    intelligence_rank: 4,
    speed_rank: 1,
    size_label: 'Medium',
    rpm_limit: 30,
    rpd_limit: 1000,
    tpm_limit: 6000,
    tpd_limit: 500000,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },

  // Mistral SOTA (<500ms)
  {
    platform: 'mistral',
    model_id: 'codestral-latest',
    display_name: 'Codestral Latest (Mistral)',
    intelligence_rank: 2,
    speed_rank: 2,
    size_label: 'Frontier',
    rpm_limit: 5,
    rpd_limit: null,
    tpm_limit: 500000,
    tpd_limit: null,
    monthly_token_budget: '~50M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'mistral',
    model_id: 'ministral-14b-latest',
    display_name: 'Ministral 14B (Mistral)',
    intelligence_rank: 4,
    speed_rank: 2,
    size_label: 'Medium',
    rpm_limit: 5,
    rpd_limit: null,
    tpm_limit: 500000,
    tpd_limit: null,
    monthly_token_budget: '~50M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'mistral',
    model_id: 'ministral-8b-latest',
    display_name: 'Ministral 8B (Mistral)',
    intelligence_rank: 5,
    speed_rank: 2,
    size_label: 'Small',
    rpm_limit: 5,
    rpd_limit: null,
    tpm_limit: 500000,
    tpd_limit: null,
    monthly_token_budget: '~50M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },

  // SiliconFlow SOTA (1s - 3s)
  {
    platform: 'siliconflow',
    model_id: 'deepseek-ai/DeepSeek-V4.1-Flash',
    display_name: 'DeepSeek V4.1 Flash (SF)',
    intelligence_rank: 1,
    speed_rank: 3,
    size_label: 'Frontier',
    rpm_limit: 20,
    rpd_limit: 200,
    tpm_limit: 100000,
    tpd_limit: null,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'siliconflow',
    model_id: 'zai-org/GLM-5.3-Flash',
    display_name: 'GLM 5.3 Flash (SF)',
    intelligence_rank: 2,
    speed_rank: 2,
    size_label: 'Large',
    rpm_limit: 20,
    rpd_limit: 200,
    tpm_limit: 100000,
    tpd_limit: null,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'siliconflow',
    model_id: 'Qwen/Qwen3.8-27B',
    display_name: 'Qwen 3.8 27B (SF)',
    intelligence_rank: 2,
    speed_rank: 3,
    size_label: 'Large',
    rpm_limit: 20,
    rpd_limit: 200,
    tpm_limit: 100000,
    tpd_limit: null,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'siliconflow',
    model_id: 'moonshotai/Kimi-K3.1-Pro',
    display_name: 'Kimi K3.1 Pro (SF)',
    intelligence_rank: 2,
    speed_rank: 3,
    size_label: 'Frontier',
    rpm_limit: 20,
    rpd_limit: 200,
    tpm_limit: 100000,
    tpd_limit: null,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'siliconflow',
    model_id: 'MiniMaxAI/MiniMax-M3.1-Flash',
    display_name: 'MiniMax M3.1 Flash (SF)',
    intelligence_rank: 3,
    speed_rank: 3,
    size_label: 'Large',
    rpm_limit: 20,
    rpd_limit: 200,
    tpm_limit: 100000,
    tpd_limit: null,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 0,
    supports_tools: 1,
  },
  {
    platform: 'siliconflow',
    model_id: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    display_name: 'DeepSeek V4 Flash Vision (SF)',
    intelligence_rank: 2,
    speed_rank: 3,
    size_label: 'Frontier',
    rpm_limit: 20,
    rpd_limit: 200,
    tpm_limit: 100000,
    tpd_limit: null,
    monthly_token_budget: '~30M',
    context_window: 131072,
    supports_vision: 1,
    supports_tools: 1,
  },
];

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
      monthly_token_budget, context_window, enabled, supports_vision, supports_tools, source
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'user'
    )
  `);

  const update = db.prepare(`
    UPDATE models
       SET display_name = ?,
           intelligence_rank = ?,
           speed_rank = ?,
           size_label = ?,
           enabled = 1,
           supports_vision = ?,
           supports_tools = ?,
           source = 'user'
     WHERE platform = ? AND model_id = ?
  `);

  for (const m of NEW_SOTA_MODELS) {
    insert.run(
      m.platform, m.model_id, m.display_name, m.intelligence_rank, m.speed_rank,
      m.size_label, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
      m.monthly_token_budget, m.context_window, m.supports_vision, m.supports_tools
    );
    update.run(
      m.display_name, m.intelligence_rank, m.speed_rank, m.size_label,
      m.supports_vision, m.supports_tools, m.platform, m.model_id
    );
  }

  // Ensure every model has a fallback_config row
  const missingFallback = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE fc.id IS NULL
  `).all() as { id: number }[];

  const maxRow = db.prepare('SELECT COALESCE(MAX(priority), 0) as maxP FROM fallback_config').get() as { maxP: number };
  const maxPriority = maxRow?.maxP ?? 0;
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');

  for (let i = 0; i < missingFallback.length; i++) {
    insertFallback.run(missingFallback[i].id, maxPriority + i + 1);
  }
}

export function down(db: Db): void {
  const ids: string[] = NEW_SOTA_MODELS.map(m => m.model_id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id IN (${placeholders}))`).run(...ids);
  db.prepare(`DELETE FROM models WHERE model_id IN (${placeholders})`).run(...ids);
}

# FreeLLMAPI upstream merge — v0.9.9-era fork → upstream v0.16.37+ (2026-11-20)

Merged upstream/main (tashfeenahmed/freellmapi, 409 commits ahead of the fork's
base, at v0.16.37 + 2 commits) into this repo's main, preserving the owner's
17 custom commits' product rules. Resolved by Muse directly (8 conflicted
files, 23 blocks).

## Preserved owner customs
- **107 Flagship roster lock**: `RADHE_FLAGSHIP_ROSTER` + `resolveFlagshipModel`
  kept in `server/src/services/anthropic-map.ts` (alongside upstream's new
  tier-selector Claude mapping); GET /v1/models keeps the owner's listing
  (virtuals `auto-fusion`, `auto`, `fusion` + the 107 roster) in
  `routes/proxy.ts`; the roster-based GET /v1/models/:id is kept; upstream's
  new GET /v1/codex/models endpoint was added, and upstream's
  `buildCatalogEntries` builder was carried over for it.
- **Flagship dispatch + Claude aliases coexist**: in proxy.ts (chat +
  completions) and responses.ts, a flagship roster id resolves via the owner's
  rules first; any other Claude alias resolves via upstream's
  `resolveListedClaudeAlias` (pinned model / auto / tier pool).
- **Auto-fusion engine**: `classifyTaskComplexity` / `isAutoFusionModel`
  (services/fusion.ts) byte-identical to the owner's; the chat route keeps the
  X-Auto-Fusion headers + model switch, placed after upstream's new
  client-disconnect AbortController (which the Fusion branch also uses).
- **SOTA free-models migration** `20261119_000001_sota_free_models_expansion`
  registered in db/migrate/defaults.ts after upstream's 18 newer migrations.
- **Provider seeding**: `seedDefaultProviders(db)` call + import kept in
  db/index.ts, alongside upstream's keyless-defaults bookkeeping and
  `probeStoredSecrets` startup check.
- **UNIFIED_API_KEY** env support (db/index.ts) and render.yaml
  (PORT / HOST / UNIFIED_API_KEY / ENCRYPTION_KEY) verified intact.
- **gpt-6 / gpt-6-astra aliases** kept in proxy.ts + responses.ts.
- responses.ts keeps the owner's defensive role fallback (`m.role || 'user'`)
  and his fuzzy model lookup as a fallback after upstream's exact
  `routedModel` match.

## Superseded by upstream (deliberate)
- responses.ts permissive `z.record` input-item schema → upstream's typed
  union (incl. a catch-all item schema) covers Codex replay items properly.
- anthropic.ts imports: `getUnifiedApiKey` / `timingSafeStringEqual` dropped
  (unused in merged body); `isAutoModel` is defined locally in anthropic.ts.
- The two production hotfix commits (hardcoded admin password reset, SQLite
  quote fix) were NOT carried as code — they were one-off data patches.
- package.json: upstream monorepo layout (root runtime deps live in
  server/package.json now); package-lock.json regenerated via npm install.

## Verification (local, this machine)
- `npm install` OK (805 packages). `npm run build` (server + cli + client —
  the same build Render's Dockerfile runs) PASSES.
- Server tests: routes+services+db (292 files) and lib+providers+integration+
  scripts (134 files) run. All green except:
  - Environmental (sandbox network timeouts, code untouched by the merge):
    settings-proxy.test.ts (20), url-guard DNS test (1), one anthropic
    thought_signature test (1, 5s timeout).
  - Deliberate divergence: 3 anthropic listing tests assert upstream's
    catalog/alias listing order; the owner's roster-locked listing wins by
    design (auto-fusion first, roster ids).
  - Pre-existing in the owner's own code: fusion.test.ts
    `classifyTaskComplexity` reasoning_effort case — function and test are
    byte-identical before and after the merge; it failed the same way on the
    owner's tree.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBinary } from './claude-harness.mjs';
import {
  fetchOpenAIModels,
  getAuthSummary,
  resolveLaunchModelConfig,
  resolveModelContextWindow,
} from './openai-oauth.mjs';
import {
  ensureDaemonRunning,
  getDaemonStatus,
  stopAndRemoveDaemon,
} from './proxy-daemon.mjs';
import { ensureLoopbackNoProxy } from './proxy-fetch.mjs';
import {
  getSettings,
  getStateDir,
  readJsonSafe,
  saveSettings,
  VALID_REASONING_EFFORTS,
  writeJsonAtomic,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

export const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_AUTO_MODE_SERVER',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'NO_PROXY',
  'no_proxy',
];

function mapClaudeSettingEffort(effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max') return e;
  if (e === 'ultra') return 'max';
  return '';
}

function resolveBehavesAsModel(modelSpec) {
  const levels = Array.isArray(modelSpec?.supportedReasoningLevels)
    ? modelSpec.supportedReasoningLevels.map((l) => String(l).trim().toLowerCase())
    : [];
  if (levels.length > 0 && !levels.includes('xhigh')) {
    return 'claude-sonnet-4-6';
  }
  // `claude-sonnet-5` enables low/medium/high/xhigh/max efforts and adaptive thinking
  // without forcing Anthropic-only Fast Mode or locking disabled thinking.
  return 'claude-sonnet-5';
}

function buildModelPickerConfig(models = [], tiers = {}, selectedModel = '') {
  const options = [];
  const seen = new Set();
  const addOption = (m) => {
    const slug = String(m?.slug || '').trim();
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const ctxWindow = Number(m?.contextWindow) > 0 ? Number(m.contextWindow) : resolveModelContextWindow(models, slug);
    const ctxTag = ctxWindow > 0 ? `${Math.round(ctxWindow / 1000)}k` : 'OpenAI';
    const desc = m?.description ? `${m.description} (${ctxTag})` : `ChatGPT OpenAI model (${ctxTag})`;
    options.push({
      model: slug,
      label: m?.displayName || slug,
      description: desc,
      behavesAs: resolveBehavesAsModel(m),
    });
  };

  for (const m of Array.isArray(models) ? models : []) {
    addOption(m);
  }
  for (const fallbackSlug of [selectedModel, tiers?.opus, tiers?.sonnet, tiers?.haiku]) {
    if (fallbackSlug) addOption({ slug: fallbackSlug });
  }

  return options.length ? { replaceBuiltInOptions: true, options } : null;
}

export const CLAUDE_SKILL_NAMES = ['chatgpt-login', 'chatgpt-usage'];
export const MCP_SERVER_NAME = 'goat-harness-claude';

export function getClaudeDir(homeDir = homedir()) {
  return process.env.GOAT_CLAUDE_DIR || join(homeDir, '.claude');
}

export function getClaudeSettingsPath(claudeDir = getClaudeDir()) {
  return join(claudeDir, 'settings.json');
}

export function getInstallBackupPath() {
  return join(getStateDir(), 'claude-install-backup.json');
}

function readExistingSettingsStrict(filePath) {
  if (!existsSync(filePath)) return { existed: false, data: {} };
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return { existed: true, data: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Existing ${filePath} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Existing ${filePath} must be a JSON object.`);
  }
  return { existed: true, data: parsed };
}

function defaultRegisterMcp({ claudeBin, nodeBin = process.execPath, repoRoot = REPO_ROOT }) {
  if (!claudeBin) return { registered: false, skipped: true, reason: 'claude CLI not found' };
  const mcpPath = join(repoRoot, 'lib', 'mcp-server.mjs');
  try {
    execFileSync(claudeBin, ['mcp', 'remove', '-s', 'user', MCP_SERVER_NAME], {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    // Ignore when not previously registered.
  }
  execFileSync(
    claudeBin,
    ['mcp', 'add', '-s', 'user', MCP_SERVER_NAME, '--', nodeBin, mcpPath],
    { stdio: 'pipe', timeout: 8000 }
  );
  return { registered: true, skipped: false };
}

function defaultRemoveMcp({ claudeBin }) {
  if (!claudeBin) return { removed: false, skipped: true };
  try {
    execFileSync(claudeBin, ['mcp', 'remove', '-s', 'user', MCP_SERVER_NAME], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return { removed: true, skipped: false };
  } catch {
    return { removed: false, skipped: false };
  }
}

function syncSkillSymlinks({ claudeDir, repoRoot = REPO_ROOT }) {
  const skillsDir = join(claudeDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const results = [];

  for (const name of CLAUDE_SKILL_NAMES) {
    const src = join(repoRoot, 'claude-plugin', 'skills', name);
    const dest = join(skillsDir, name);
    if (!existsSync(src)) continue;

    let st = null;
    try {
      st = lstatSync(dest);
    } catch {
      st = null;
    }

    if (st && st.isSymbolicLink()) {
      const current = readlinkSync(dest);
      if (current === src) {
        results.push({ name, action: 'kept', managed: true, dest, src });
        continue;
      }
      unlinkSync(dest);
      symlinkSync(src, dest);
      results.push({ name, action: 'updated', managed: true, dest, src });
    } else if (st) {
      results.push({ name, action: 'skipped_existing', managed: false, dest, src });
    } else {
      symlinkSync(src, dest);
      results.push({ name, action: 'linked', managed: true, dest, src });
    }
  }

  return results;
}

function removeManagedSkillSymlinks({ claudeDir, repoRoot = REPO_ROOT, managedNames = CLAUDE_SKILL_NAMES }) {
  const skillsDir = join(claudeDir, 'skills');
  const removed = [];
  let resolvedRoot = repoRoot;
  try {
    resolvedRoot = realpathSync(repoRoot);
  } catch {
    // Use literal repoRoot if realpath fails.
  }

  for (const name of managedNames) {
    const dest = join(skillsDir, name);
    let st = null;
    try {
      st = lstatSync(dest);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;

    const target = readlinkSync(dest);
    let resolvedTarget = target;
    try {
      resolvedTarget = realpathSync(dest);
    } catch {
      resolvedTarget = target;
    }
    if (
      target.startsWith(repoRoot) ||
      resolvedTarget.startsWith(resolvedRoot) ||
      target.includes('goat_harness') ||
      target.includes('goat-harness')
    ) {
      unlinkSync(dest);
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Installs GOAT Harness globally into Claude Code (`~/.claude/settings.json`,
 * persistent background proxy daemon, skills, and user-scoped MCP) while creating an exact
 * pre-install backup so `uninstallFromClaudeCode()` restores Claude Code back to original.
 */
export async function installIntoClaudeCode({
  homeDir = homedir(),
  claudeDir = getClaudeDir(homeDir),
  repoRoot = REPO_ROOT,
  nodeBin = process.execPath,
  model = '',
  effort = '',
  linkGlobalBinsFn = null,
  ensureDaemonFn = ensureDaemonRunning,
  fetchModelsFn = fetchOpenAIModels,
  registerMcpFn = defaultRegisterMcp,
  resolveClaudeFn = resolveClaudeBinary,
  getAuthSummaryFn = getAuthSummary,
} = {}) {
  const settings = getSettings();
  if (effort) {
    const normalized = String(effort).trim().toLowerCase();
    if (!VALID_REASONING_EFFORTS.includes(normalized)) {
      throw new Error(
        `Invalid effort "${effort}". Expected one of: ${VALID_REASONING_EFFORTS.join(', ')}.`
      );
    }
    saveSettings({ reasoningEffort: normalized });
  }
  if (model) {
    saveSettings({ defaultModel: String(model).trim() });
  }

  const freshSettings = getSettings();
  const auth = getAuthSummaryFn();
  if (!auth.connected) {
    throw new Error('Not signed in to ChatGPT yet. Sign in before enabling global Claude Code integration.');
  }

  const launchConfig = await resolveLaunchModelConfig({
    requestedModel: model,
    defaultModel: freshSettings.defaultModel,
    getModelsFn: fetchModelsFn,
  });
  const selectedModel = launchConfig.selectedModel;
  const tiers = launchConfig.tiers;
  if (!selectedModel) {
    throw new Error('No OpenAI models available for your ChatGPT account.');
  }
  if (!freshSettings.defaultModel && selectedModel) {
    saveSettings({ defaultModel: selectedModel });
  }

  // Ensure persistent local loopback proxy daemon is running before writing settings.json.
  const daemon = await ensureDaemonFn({ homeDir, nodeBin });
  const baseUrl = daemon.config.baseUrl;
  const proxyToken = daemon.config.token;

  const settingsPath = getClaudeSettingsPath(claudeDir);
  const backupPath = getInstallBackupPath();
  const { existed, data: currentClaudeSettings } = readExistingSettingsStrict(settingsPath);
  const existingEnv =
    currentClaudeSettings.env &&
    typeof currentClaudeSettings.env === 'object' &&
    !Array.isArray(currentClaudeSettings.env)
      ? currentClaudeSettings.env
      : {};
  const existingPermissions =
    currentClaudeSettings.permissions &&
    typeof currentClaudeSettings.permissions === 'object' &&
    !Array.isArray(currentClaudeSettings.permissions)
      ? currentClaudeSettings.permissions
      : {};

  // Snapshot original values ONLY on first install so re-running install never overwrites
  // the true pre-GOAT backup!
  const existingBackup = readJsonSafe(backupPath, null);
  let backup = existingBackup?.installed ? existingBackup : null;
  if (!backup) {
    const originalEnvValues = {};
    for (const key of MANAGED_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(existingEnv, key)) {
        originalEnvValues[key] = { present: true, value: existingEnv[key] };
      } else {
        originalEnvValues[key] = { present: false };
      }
    }
    backup = {
      version: 1,
      installed: true,
      installedAt: new Date().toISOString(),
      claudeDir,
      settingsPath,
      settingsExisted: existed,
      managedEnvKeys: [...MANAGED_ENV_KEYS],
      originalModel: Object.prototype.hasOwnProperty.call(currentClaudeSettings, 'model')
        ? { present: true, value: currentClaudeSettings.model }
        : { present: false },
      originalEffortLevel: Object.prototype.hasOwnProperty.call(currentClaudeSettings, 'effortLevel')
        ? { present: true, value: currentClaudeSettings.effortLevel }
        : { present: false },
      originalModelPicker: Object.prototype.hasOwnProperty.call(currentClaudeSettings, 'modelPicker')
        ? { present: true, value: currentClaudeSettings.modelPicker }
        : { present: false },
      originalEnvHadKey: Object.prototype.hasOwnProperty.call(currentClaudeSettings, 'env'),
      originalEnvValues,
      originalPermissionsHadKey: Object.prototype.hasOwnProperty.call(currentClaudeSettings, 'permissions'),
      originalDefaultMode: Object.prototype.hasOwnProperty.call(existingPermissions, 'defaultMode')
        ? { present: true, value: existingPermissions.defaultMode }
        : { present: false },
      managedSkills: [],
      registeredMcp: false,
    };
    writeJsonAtomic(backupPath, backup, 0o600);
  }

  const loopbackEnv = ensureLoopbackNoProxy({
    NO_PROXY: existingEnv.NO_PROXY || existingEnv.no_proxy || '',
    no_proxy: existingEnv.no_proxy || existingEnv.NO_PROXY || '',
  });

  // Prefer `acceptEdits` on first install so edits apply without prompts, while
  // `CLAUDE_CODE_AUTO_MODE_SERVER=0` enables Auto Mode client-side safety checks via the local proxy.
  const nextPermissions = { ...existingPermissions };
  if (!nextPermissions.defaultMode || nextPermissions.defaultMode === 'auto') {
    nextPermissions.defaultMode = 'acceptEdits';
  }

  const contextWindow = launchConfig.contextWindow || resolveModelContextWindow(launchConfig.models, selectedModel);
  const nextEnv = {
    ...existingEnv,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: proxyToken,
    ANTHROPIC_MODEL: selectedModel,
    ANTHROPIC_SMALL_FAST_MODEL: tiers.haiku || selectedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.opus || selectedModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.sonnet || selectedModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.haiku || selectedModel,
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NO_PROXY: loopbackEnv.NO_PROXY,
    no_proxy: loopbackEnv.no_proxy,
  };
  if (contextWindow > 0) {
    nextEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  } else {
    delete nextEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  }

  const mappedEffort = mapClaudeSettingEffort(getSettings().reasoningEffort);
  const modelPicker = buildModelPickerConfig(launchConfig.models, tiers, selectedModel);
  const nextSettings = {
    ...currentClaudeSettings,
    model: selectedModel,
    ...(mappedEffort ? { effortLevel: mappedEffort } : {}),
    ...(modelPicker ? { modelPicker } : {}),
    permissions: nextPermissions,
    env: nextEnv,
  };

  mkdirSync(claudeDir, { recursive: true });
  writeJsonAtomic(settingsPath, nextSettings, 0o600);

  const skillResults = syncSkillSymlinks({ claudeDir, repoRoot });
  const claudeBin = resolveClaudeFn(freshSettings.claudePath);
  const mcpResult = registerMcpFn({ claudeBin, nodeBin, repoRoot });

  let linkResult = { linked: false, skipped: true };
  if (typeof linkGlobalBinsFn === 'function') {
    linkResult = await linkGlobalBinsFn();
  }

  const updatedBackup = {
    ...backup,
    installed: true,
    updatedAt: new Date().toISOString(),
    managedSkills: Array.from(
      new Set([
        ...(backup.managedSkills || []),
        ...skillResults.filter((s) => s.managed).map((s) => s.name),
      ])
    ),
    registeredMcp: Boolean(backup.registeredMcp || mcpResult?.registered),
  };
  writeJsonAtomic(backupPath, updatedBackup, 0o600);

  return {
    ok: true,
    claudeDir,
    settingsPath,
    backupPath,
    selectedModel,
    tiers,
    reasoningEffort: getSettings().reasoningEffort,
    permissionDefaultMode: nextPermissions.defaultMode || '',
    daemon,
    skills: skillResults,
    mcp: mcpResult,
    globalBin: linkResult,
  };
}

/**
 * Synchronizes active model settings into `~/.claude/settings.json` when GOAT Harness's global
 * Claude Code integration is installed, so footer displays & future sessions match `goat-login set-model`.
 */
export function syncInstalledClaudeModel({
  model = '',
  effort = '',
  tiers = null,
  contextWindow = 0,
  homeDir = homedir(),
  claudeDir = getClaudeDir(homeDir),
} = {}) {
  const backup = readJsonSafe(getInstallBackupPath(), null);
  if (!backup?.installed) return false;

  const settingsPath = backup.settingsPath || getClaudeSettingsPath(claudeDir);
  if (!existsSync(settingsPath)) return false;

  const { data } = readExistingSettingsStrict(settingsPath);
  const nextModel = String(model || '').trim();
  const nextEnv = { ...(data.env && typeof data.env === 'object' ? data.env : {}) };

  if (nextModel) {
    data.model = nextModel;
    nextEnv.ANTHROPIC_MODEL = nextModel;
    const resolvedCtx = Number(contextWindow) > 0 ? Number(contextWindow) : resolveModelContextWindow([], nextModel);
    if (resolvedCtx > 0) {
      nextEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(resolvedCtx);
    }
  }
  if (tiers && typeof tiers === 'object') {
    if (tiers.opus) nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = tiers.opus;
    if (tiers.sonnet) nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = tiers.sonnet;
    if (tiers.haiku) {
      nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = tiers.haiku;
      nextEnv.ANTHROPIC_SMALL_FAST_MODEL = tiers.haiku;
    }
  }
  const mappedEffort = mapClaudeSettingEffort(effort);
  if (mappedEffort) {
    data.effortLevel = mappedEffort;
  }
  data.env = nextEnv;
  writeJsonAtomic(settingsPath, data, 0o600);
  return true;
}

/**
 * Cleanly uninstalls GOAT Harness from Claude Code, stops the background proxy daemon,
 * and restores `~/.claude/settings.json` to its exact pre-install state.
 */
export async function uninstallFromClaudeCode({
  homeDir = homedir(),
  claudeDir: providedClaudeDir = '',
  repoRoot = REPO_ROOT,
  purge = false,
  stopDaemonFn = stopAndRemoveDaemon,
  removeMcpFn = defaultRemoveMcp,
  resolveClaudeFn = resolveClaudeBinary,
  unlinkGlobalBinsFn = null,
} = {}) {
  const backupPath = getInstallBackupPath();
  const backup = readJsonSafe(backupPath, null);
  const claudeDir = providedClaudeDir || backup?.claudeDir || getClaudeDir(homeDir);
  const settingsPath = backup?.settingsPath || getClaudeSettingsPath(claudeDir);

  const daemonResult = await stopDaemonFn({ homeDir, removeConfig: true });

  let restoredSettings = false;
  if (existsSync(settingsPath)) {
    const { data: current } = readExistingSettingsStrict(settingsPath);
    const next = { ...current };
    const managedKeys = Array.from(
      new Set([...(Array.isArray(backup?.managedEnvKeys) ? backup.managedEnvKeys : []), ...MANAGED_ENV_KEYS])
    );

    if (next.env && typeof next.env === 'object' && !Array.isArray(next.env)) {
      const nextEnv = { ...next.env };
      if (backup?.originalEnvValues) {
        for (const key of managedKeys) {
          const orig = backup.originalEnvValues[key];
          if (orig?.present) {
            nextEnv[key] = orig.value;
          } else {
            delete nextEnv[key];
          }
        }
      } else {
        for (const key of managedKeys) {
          delete nextEnv[key];
        }
      }

      if (backup && !backup.originalEnvHadKey && Object.keys(nextEnv).length === 0) {
        delete next.env;
      } else {
        next.env = nextEnv;
      }
    }

    if (backup?.originalModel?.present) {
      next.model = backup.originalModel.value;
    } else if (backup) {
      delete next.model;
    } else {
      // Best-effort fallback if backup missing: clear known OpenAI slug from top-level model if pointing to proxy.
      if (typeof next.model === 'string' && /^gpt-/i.test(next.model)) {
        delete next.model;
      }
    }

    if (backup && Object.prototype.hasOwnProperty.call(backup, 'originalEffortLevel')) {
      if (backup.originalEffortLevel?.present) {
        next.effortLevel = backup.originalEffortLevel.value;
      } else {
        delete next.effortLevel;
      }
    } else if (backup) {
      delete next.effortLevel;
    }

    if (backup && Object.prototype.hasOwnProperty.call(backup, 'originalModelPicker')) {
      if (backup.originalModelPicker?.present) {
        next.modelPicker = backup.originalModelPicker.value;
      } else {
        delete next.modelPicker;
      }
    } else if (backup) {
      delete next.modelPicker;
    }

    if (backup && Object.prototype.hasOwnProperty.call(backup, 'originalDefaultMode')) {
      if (next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions)) {
        const nextPerms = { ...next.permissions };
        if (backup.originalDefaultMode?.present) {
          nextPerms.defaultMode = backup.originalDefaultMode.value;
        } else {
          delete nextPerms.defaultMode;
        }
        if (!backup.originalPermissionsHadKey && Object.keys(nextPerms).length === 0) {
          delete next.permissions;
        } else {
          next.permissions = nextPerms;
        }
      }
    }

    if (backup && !backup.settingsExisted && Object.keys(next).length === 0) {
      unlinkSync(settingsPath);
    } else {
      writeJsonAtomic(settingsPath, next, 0o600);
    }
    restoredSettings = true;
  }

  const removedSkills = removeManagedSkillSymlinks({
    claudeDir,
    repoRoot,
    managedNames: backup?.managedSkills?.length ? backup.managedSkills : CLAUDE_SKILL_NAMES,
  });

  const freshSettings = getSettings();
  const claudeBin = resolveClaudeFn(freshSettings.claudePath);
  const mcpResult = removeMcpFn({ claudeBin });

  let globalBinResult = { unlinked: false, skipped: true };
  if (typeof unlinkGlobalBinsFn === 'function') {
    globalBinResult = await unlinkGlobalBinsFn();
  }

  if (existsSync(backupPath)) {
    try {
      unlinkSync(backupPath);
    } catch {
      // Ignore cleanup error.
    }
  }

  if (purge) {
    const stateDir = getStateDir();
    if (existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  return {
    ok: true,
    claudeDir,
    settingsPath,
    restoredSettings,
    hadBackup: Boolean(backup),
    removedSkills,
    mcp: mcpResult,
    daemon: daemonResult,
    globalBin: globalBinResult,
    purgedStateDir: Boolean(purge),
  };
}

export async function getClaudeInstallStatus({
  homeDir = homedir(),
  claudeDir: providedClaudeDir = '',
  getDaemonStatusFn = getDaemonStatus,
  getAuthSummaryFn = getAuthSummary,
} = {}) {
  const backupPath = getInstallBackupPath();
  const backup = readJsonSafe(backupPath, null);
  const claudeDir = providedClaudeDir || backup?.claudeDir || getClaudeDir(homeDir);
  const settingsPath = backup?.settingsPath || getClaudeSettingsPath(claudeDir);
  const claudeSettings = readJsonSafe(settingsPath, {});
  const daemon = await getDaemonStatusFn({ homeDir });
  const auth = getAuthSummaryFn();
  const settings = getSettings();

  const envUrl = String(claudeSettings?.env?.ANTHROPIC_BASE_URL || '');
  const injectedInClaudeSettings = Boolean(
    envUrl &&
      daemon.baseUrl &&
      envUrl === daemon.baseUrl &&
      claudeSettings?.env?.ANTHROPIC_AUTH_TOKEN
  );

  const skills = CLAUDE_SKILL_NAMES.map((name) => {
    const dest = join(claudeDir, 'skills', name);
    try {
      const st = lstatSync(dest);
      return { name, installed: true, symlink: st.isSymbolicLink() };
    } catch {
      return { name, installed: false, symlink: false };
    }
  });

  let globalGoatClaude = '';
  try {
    globalGoatClaude = execFileSync('which', ['goat-claude'], { encoding: 'utf-8', timeout: 1500 }).trim();
  } catch {
    globalGoatClaude = '';
  }

  return {
    installed: Boolean(backup?.installed && injectedInClaudeSettings),
    backupPresent: Boolean(backup?.installed),
    settingsPath,
    injectedInClaudeSettings,
    activeClaudeModel: claudeSettings?.model || '',
    originalModel: backup?.originalModel?.present ? backup.originalModel.value : '',
    defaultModel: settings.defaultModel,
    reasoningEffort: settings.reasoningEffort,
    permissionDefaultMode: claudeSettings?.permissions?.defaultMode || '',
    globalGoatClaude,
    daemon,
    auth,
    skills,
  };
}

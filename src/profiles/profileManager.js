'use strict';

/**
 * profileManager.js — Multi-user profile management.
 *
 * Each profile gets its own directory under data/profiles/<name>/ containing:
 *   - config.json          (user-specific settings, profile info, keywords)
 *   - auth.json            (user-specific browser session cookies)
 *   - autoapply.db         (user-specific job history — auto-created by db.js)
 *   - resume_extracted.txt (user-specific resume text)
 *
 * A master registry at data/profiles/profiles.json tracks all profiles.
 */

const fs   = require('fs');
const path = require('path');
const { ROLES, isValidRole } = require('./roles');

const DATA_DIR       = path.join(process.cwd(), 'data');
const PROFILES_DIR   = path.join(DATA_DIR, 'profiles');
const REGISTRY_PATH  = path.join(PROFILES_DIR, 'profiles.json');
const EXAMPLE_CONFIG = path.join(process.cwd(), 'config', 'config.example.json');
const GLOBAL_CONFIG  = path.join(process.cwd(), 'config', 'config.json');

// ── Ensure profiles directory exists ─────────────────────────────────────────
function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Registry I/O ─────────────────────────────────────────────────────────────
function _readRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch (_) {}
  return { activeProfile: 'default', profiles: {} };
}

function _writeRegistry(registry) {
  _ensureDir(PROFILES_DIR);
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// ── Profile directory ────────────────────────────────────────────────────────
function _profileDir(name) {
  return path.join(PROFILES_DIR, name.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
}

function _profileConfigPath(name) {
  return path.join(_profileDir(name), 'config.json');
}

function _profileAuthPath(name) {
  return path.join(_profileDir(name), 'auth.json');
}

function _profileDbPath(name) {
  return path.join(_profileDir(name), 'autoapply.db');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialise the profile system.
 * Creates 'default' profile from existing config if no profiles exist yet.
 */
function init() {
  _ensureDir(PROFILES_DIR);
  const registry = _readRegistry();

  if (Object.keys(registry.profiles).length === 0) {
    // Bootstrap: create 'default' profile from existing global config
    const defaultDir = _profileDir('default');
    _ensureDir(defaultDir);

    // Copy config
    let configSrc = GLOBAL_CONFIG;
    if (!fs.existsSync(configSrc)) configSrc = EXAMPLE_CONFIG;
    if (fs.existsSync(configSrc)) {
      fs.copyFileSync(configSrc, path.join(defaultDir, 'config.json'));
    }

    // Copy auth if exists
    const globalAuth = path.join(process.cwd(), 'auth.json');
    if (fs.existsSync(globalAuth)) {
      fs.copyFileSync(globalAuth, path.join(defaultDir, 'auth.json'));
    }

    registry.profiles['default'] = {
      name: 'default',
      role: ROLES.admin,
      createdAt: new Date().toISOString(),
    };
    registry.activeProfile = 'default';
    _writeRegistry(registry);
  }

  return registry;
}

/**
 * List all profiles.
 * @returns {{ name: string, role: string, createdAt: string, isActive: boolean }[]}
 */
function listProfiles() {
  const registry = _readRegistry();
  return Object.entries(registry.profiles).map(([name, meta]) => ({
    name,
    role: meta.role || ROLES.user,
    createdAt: meta.createdAt || '',
    isActive: name === registry.activeProfile,
    displayName: meta.displayName || name,
  }));
}

/**
 * Create a new profile.
 * @param {string} name     - Profile identifier (alphanumeric + _ -)
 * @param {string} role     - One of: admin, user, viewer
 * @param {string} [displayName] - Human-readable display name
 * @returns {{ success: boolean, error?: string }}
 */
function createProfile(name, role = ROLES.user, displayName = '') {
  if (!name || typeof name !== 'string') return { success: false, error: 'Name required' };
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!safeName) return { success: false, error: 'Invalid name' };
  if (!isValidRole(role)) return { success: false, error: `Invalid role: ${role}` };

  const registry = _readRegistry();
  if (registry.profiles[safeName]) return { success: false, error: 'Profile already exists' };

  // Create profile directory
  const dir = _profileDir(safeName);
  _ensureDir(dir);

  // Copy example config as the starting point
  const src = fs.existsSync(EXAMPLE_CONFIG) ? EXAMPLE_CONFIG : GLOBAL_CONFIG;
  if (fs.existsSync(src)) {
    const config = JSON.parse(fs.readFileSync(src, 'utf8'));
    config.profile = config.profile || {};
    config.profile.name = displayName || safeName;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  }

  // Register profile
  registry.profiles[safeName] = {
    name: safeName,
    displayName: displayName || safeName,
    role,
    createdAt: new Date().toISOString(),
  };
  _writeRegistry(registry);

  return { success: true, name: safeName };
}

/**
 * Delete a profile.
 * @param {string} name
 * @returns {{ success: boolean, error?: string }}
 */
function deleteProfile(name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (safeName === 'default') return { success: false, error: 'Cannot delete default profile' };

  const registry = _readRegistry();
  if (!registry.profiles[safeName]) return { success: false, error: 'Profile not found' };

  // Remove directory
  const dir = _profileDir(safeName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Update registry
  delete registry.profiles[safeName];
  if (registry.activeProfile === safeName) registry.activeProfile = 'default';
  _writeRegistry(registry);

  return { success: true };
}

/**
 * Switch active profile.
 * @param {string} name
 * @returns {{ success: boolean, error?: string, profile?: object }}
 */
function switchProfile(name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const registry = _readRegistry();

  if (!registry.profiles[safeName]) return { success: false, error: 'Profile not found' };

  registry.activeProfile = safeName;
  _writeRegistry(registry);

  return { success: true, profile: registry.profiles[safeName] };
}

/**
 * Get the active profile name.
 * @returns {string}
 */
function getActiveProfile() {
  const registry = _readRegistry();
  return registry.activeProfile || 'default';
}

/**
 * Get profile metadata.
 * @param {string} name
 * @returns {object|null}
 */
function getProfile(name) {
  const safeName = (name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const registry = _readRegistry();
  return registry.profiles[safeName] || null;
}

/**
 * Update profile role.
 * @param {string} name
 * @param {string} role
 * @returns {{ success: boolean, error?: string }}
 */
function updateProfileRole(name, role) {
  if (!isValidRole(role)) return { success: false, error: `Invalid role: ${role}` };
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const registry = _readRegistry();
  if (!registry.profiles[safeName]) return { success: false, error: 'Profile not found' };

  registry.profiles[safeName].role = role;
  _writeRegistry(registry);
  return { success: true };
}

/**
 * Read config for a profile.
 * Falls back to global config.json, then config.example.json.
 */
function readProfileConfig(name) {
  const cfgPath = _profileConfigPath(name || getActiveProfile());
  if (fs.existsSync(cfgPath)) {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
  // Fallback to global
  if (fs.existsSync(GLOBAL_CONFIG)) {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'));
  }
  if (fs.existsSync(EXAMPLE_CONFIG)) {
    return JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
  }
  return {};
}

/**
 * Write config for a profile.
 */
function writeProfileConfig(name, config) {
  const dir = _profileDir(name || getActiveProfile());
  _ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * Get file paths for the active profile.
 * @param {string} [name] - Profile name (defaults to active)
 * @returns {{ configPath, authPath, dbPath, profileDir }}
 */
function getProfilePaths(name) {
  const safeName = (name || getActiveProfile()).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return {
    configPath: _profileConfigPath(safeName),
    authPath:   _profileAuthPath(safeName),
    dbPath:     _profileDbPath(safeName),
    profileDir: _profileDir(safeName),
  };
}

module.exports = {
  init,
  listProfiles,
  createProfile,
  deleteProfile,
  switchProfile,
  getActiveProfile,
  getProfile,
  updateProfileRole,
  readProfileConfig,
  writeProfileConfig,
  getProfilePaths,
  PROFILES_DIR,
};

'use strict';

/**
 * roles.js — Role-based access control definitions.
 *
 * Roles:
 *   admin  — Full access: manage profiles, settings, run bot, view all data
 *   user   — Own profile: edit own config, run bot, view own jobs
 *   viewer — Read-only: view dashboard & stats, no bot control or edits
 */

const ROLES = {
  admin:  'admin',
  user:   'user',
  viewer: 'viewer',
};

/**
 * Permission matrix.
 * Each action maps to the set of roles allowed to perform it.
 */
const PERMISSIONS = {
  // Profile management
  'profiles:list':      [ROLES.admin],
  'profiles:create':    [ROLES.admin],
  'profiles:delete':    [ROLES.admin],
  'profiles:switch':    [ROLES.admin, ROLES.user],

  // Bot control
  'bot:start':          [ROLES.admin, ROLES.user],
  'bot:stop':           [ROLES.admin, ROLES.user],
  'bot:save-auth':      [ROLES.admin, ROLES.user],

  // Config & settings
  'config:read':        [ROLES.admin, ROLES.user, ROLES.viewer],
  'config:write':       [ROLES.admin, ROLES.user],
  'profile:read':       [ROLES.admin, ROLES.user, ROLES.viewer],
  'profile:write':      [ROLES.admin, ROLES.user],
  'keywords:write':     [ROLES.admin, ROLES.user],
  'selectors:write':    [ROLES.admin],

  // Data access
  'jobs:read':          [ROLES.admin, ROLES.user, ROLES.viewer],
  'jobs:export':        [ROLES.admin, ROLES.user],
  'jobs:import':        [ROLES.admin],
  'learning:read':      [ROLES.admin, ROLES.user, ROLES.viewer],
  'learning:write':     [ROLES.admin, ROLES.user],
  'resume:upload':      [ROLES.admin, ROLES.user],
  'blocklist:write':    [ROLES.admin, ROLES.user],

  // Dashboard
  'dashboard:view':     [ROLES.admin, ROLES.user, ROLES.viewer],
  'stats:read':         [ROLES.admin, ROLES.user, ROLES.viewer],
};

/**
 * Check if a role has permission for an action.
 * @param {string} role
 * @param {string} action
 * @returns {boolean}
 */
function hasPermission(role, action) {
  const allowed = PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(role);
}

/**
 * Get all permissions for a role.
 * @param {string} role
 * @returns {string[]}
 */
function getPermissions(role) {
  return Object.entries(PERMISSIONS)
    .filter(([, roles]) => roles.includes(role))
    .map(([action]) => action);
}

/**
 * Validate a role string.
 * @param {string} role
 * @returns {boolean}
 */
function isValidRole(role) {
  return Object.values(ROLES).includes(role);
}

module.exports = { ROLES, PERMISSIONS, hasPermission, getPermissions, isValidRole };

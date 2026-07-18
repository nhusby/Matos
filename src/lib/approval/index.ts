export {
  type ApprovalConfig,
  type ApprovalConfigPaths,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_APPROVAL_RULES,
  loadApprovalConfig,
  ensureApprovalConfig,
  WRITE_TOOLS,
  isProtectedPath,
  mentionsProtectedPath,
} from './config.js';
export {
  type ApprovalDecision,
  type ApprovalResult,
  splitCommands,
  decideApproval,
  hasRedirect,
} from './matcher.js';

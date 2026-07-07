// Re-exports from the shared url-routes module.
//
// Navigation is now handled by react-router (useNavigate / useLocation).
// This barrel keeps the re-exported type + utility aliases working so
// import sites don't need to know the backend path.

export {
  AGENT_TABS,
  AGENT_FILES_SEGMENT,
  DEFAULT_TAB,
  buildPath,
  buildKbPath,
  buildKbRawPath,
  buildAgentFilePath,
  buildAgentFileRawPath,
  parseLocation,
  parseKbPath,
  parseAgentFilePath,
  reconcileLocation,
} from '@shared/url-routes';
export type {
  AgentTab,
  AgentFileLocation,
  ReconcileSnapshot,
  UrlLocation,
  KbLocation,
} from '@shared/url-routes';

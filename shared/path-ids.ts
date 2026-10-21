// Agent and knowledge-base ids become directory names under the Anima home, so
// each must be one safe path segment: letters, digits, '.', '_' and '-', and
// never '.' or '..'.
export const PATH_SAFE_ID = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

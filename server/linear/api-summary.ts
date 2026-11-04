import { getOperationAST, Kind, parse, valueFromASTUntyped, type FieldNode, type SelectionSetNode } from 'graphql';
import { LINEAR_ISSUE_KEY } from '../../shared/linear-issue-key.js';
import { LinearApiSummary, type LinearApiChange } from '../../shared/linear-api-summary.js';

type ApiInput = { query: string; variables: Record<string, unknown>; operationName?: string };
type ApiDescription = { operation: 'query' | 'mutation' | 'subscription' | 'unknown'; fields?: string[]; fieldCount?: number; issueKey?: string };
type Fragments = Map<string, SelectionSetNode>;
export type LinearApiOperation = {
  audit: ApiDescription;
  field?: FieldNode;
  fragments: Fragments;
  variables: Record<string, unknown>;
};

const FIELD_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,63}$/;
const ISSUE_ID_ARGUMENT = new Set(['issue', 'issueUpdate', 'issueArchive', 'issueUnarchive', 'issueDelete']);
const ISSUE_INPUT_ARGUMENT = new Set(['commentCreate', 'attachmentLinkURL', 'agentSessionCreateOnIssue']);
const ISSUE_RESULT_PATHS: Record<string, string[]> = {
  issue: [], issueCreate: ['issue'], issueUpdate: ['issue'], issueArchive: ['issue'], issueUnarchive: ['issue'], issueDelete: ['issue'],
  comment: ['issue'], commentCreate: ['comment', 'issue'], commentUpdate: ['comment', 'issue'], commentDelete: ['comment', 'issue'],
  agentSession: ['issue'], agentSessionCreateOnIssue: ['agentSession', 'issue'], agentSessionCreateOnComment: ['agentSession', 'issue'], agentSessionUpdate: ['agentSession', 'issue'],
  agentActivityCreate: ['agentActivity', 'agentSession', 'issue'], attachmentLinkURL: ['attachment', 'issue'],
};
const CONNECTION_FIELDS = new Set(['issues', 'searchIssues', 'teams', 'users', 'comments']);
const CHANGE_FIELDS: Record<string, LinearApiChange> = {
  stateId: 'status', assigneeId: 'assignee', delegateId: 'delegate', title: 'title', description: 'description', priority: 'priority',
  labelIds: 'labels', projectId: 'project', teamId: 'team', cycleId: 'cycle', dueDate: 'due date',
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Merge repeated selections of one response key. Distinct aliases remain distinct
// operations, even when they call the same schema field twice.
function fields(set: SelectionSetNode | undefined, fragments: Fragments): FieldNode[] {
  const result = new Map<string, FieldNode>();
  const visited = new Set<string>();
  const visit = (selection: SelectionSetNode | undefined): void => {
    for (const node of selection?.selections ?? []) {
      if (node.kind === Kind.FIELD) {
        const key = node.alias?.value ?? node.name.value;
        const previous = result.get(key);
        if (previous && previous.name.value !== node.name.value) throw new Error('Conflicting response fields');
        result.set(key, previous ? { ...node, selectionSet: { kind: Kind.SELECTION_SET, selections: [...previous.selectionSet?.selections ?? [], ...node.selectionSet?.selections ?? []] } } : node);
      } else if (node.kind === Kind.INLINE_FRAGMENT) visit(node.selectionSet);
      else if (!visited.has(node.name.value)) {
        visited.add(node.name.value);
        visit(fragments.get(node.name.value));
      }
    }
  };
  visit(set);
  return [...result.values()];
}

function argument(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.arguments?.find((node) => node.name.value === name);
  return arg ? valueFromASTUntyped(arg.value, variables) : undefined;
}

export function describeLinearApi(input: ApiInput): LinearApiOperation {
  const fragments: Fragments = new Map();
  try {
    const document = parse(input.query);
    const operation = getOperationAST(document, input.operationName);
    if (!operation) return { audit: { operation: 'unknown' }, fragments, variables: input.variables };
    for (const node of document.definitions) if (node.kind === Kind.FRAGMENT_DEFINITION) fragments.set(node.name.value, node.selectionSet);
    const variables = { ...input.variables };
    for (const definition of operation.variableDefinitions ?? []) {
      if (!Object.hasOwn(variables, definition.variable.name.value) && definition.defaultValue) {
        variables[definition.variable.name.value] = valueFromASTUntyped(definition.defaultValue);
      }
    }
    const selected = fields(operation.selectionSet, fragments);
    const names = [...new Set(selected.map((field) => field.name.value).filter((name) => FIELD_NAME.test(name)))].slice(0, 5);
    const audit: ApiDescription = { operation: operation.operation };
    if (names.length) audit.fields = names;
    if (selected.length > 1) audit.fieldCount = selected.length;
    const field = selected.length === 1 ? selected[0] : undefined;
    if (field) {
      const name = field.name.value;
      const id = ISSUE_ID_ARGUMENT.has(name) ? argument(field, 'id', variables)
        : ISSUE_INPUT_ARGUMENT.has(name) ? object(argument(field, 'input', variables))?.issueId : undefined;
      if (typeof id === 'string' && LINEAR_ISSUE_KEY.test(id)) audit.issueKey = id;
    }
    return { audit, field, fragments, variables };
  } catch {
    return { audit: { operation: 'unknown' }, fragments, variables: input.variables };
  }
}

type SelectedValue = { value: unknown; field: FieldNode };
function child(parent: SelectedValue, name: string, fragments: Fragments): SelectedValue | undefined {
  const candidates = fields(parent.field.selectionSet, fragments).filter((field) => field.name.value === name);
  if (candidates.length !== 1) return undefined;
  const field = candidates[0]!;
  const key = field.alias?.value ?? field.name.value;
  const value = object(parent.value);
  return value && Object.hasOwn(value, key) ? { value: value[key], field } : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

/** Only values selected at known schema paths can become display metadata. */
export function summarizeLinearApi(operation: LinearApiOperation, result: unknown): LinearApiSummary | undefined {
  try {
    const { field, fragments, variables, audit } = operation;
    if (!field) return undefined;
    const root = object(result);
    const key = field.alias?.value ?? field.name.value;
    if (!root || !Object.hasOwn(root, key)) return undefined;
    const name = field.name.value;
    if (!Object.hasOwn(ISSUE_RESULT_PATHS, name) && !CONNECTION_FIELDS.has(name)) return undefined;
    const selected: SelectedValue = { field, value: root[key] };
    const summary: LinearApiSummary = {};
    if (audit.issueKey) summary.issueKey = audit.issueKey;
    if (audit.operation === 'mutation') {
      const success = child(selected, 'success', fragments)?.value;
      if (typeof success === 'boolean') summary.success = success;
      if (name === 'issueUpdate') {
        const input = object(argument(field, 'input', variables));
        const changes = Object.entries(CHANGE_FIELDS).filter(([key]) => input && Object.hasOwn(input, key)).map(([, value]) => value);
        if (changes.length) summary.changes = changes;
      }
    }
    if (audit.operation === 'query' && CONNECTION_FIELDS.has(name)) {
      const nodes = child(selected, 'nodes', fragments)?.value;
      if (Array.isArray(nodes)) summary.resultCount = nodes.length;
      const page = child(selected, 'pageInfo', fragments);
      const more = page && child(page, 'hasNextPage', fragments)?.value;
      if (typeof more === 'boolean') summary.hasNextPage = more;
    }
    let issue: SelectedValue | undefined = selected;
    const path = ISSUE_RESULT_PATHS[name];
    if (path) {
      for (const part of path) issue = issue && child(issue, part, fragments);
      if (name === 'issue' && audit.operation === 'query' && issue?.value === null) summary.found = false;
      if (issue && object(issue.value)) {
        if (name === 'issue' && audit.operation === 'query') summary.found = true;
        const identifier = child(issue, 'identifier', fragments)?.value;
        if (audit.issueKey && typeof identifier === 'string' && identifier !== audit.issueKey) return undefined;
        if (typeof identifier === 'string' && LINEAR_ISSUE_KEY.test(identifier)) summary.issueKey = identifier;
        const title = text(child(issue, 'title', fragments)?.value, 240);
        if (title) summary.issueTitle = title;
        const url = child(issue, 'url', fragments)?.value;
        if (typeof url === 'string' && LinearApiSummary.shape.issueUrl.safeParse(url).success
          && (!summary.issueKey || new URL(url).pathname.split('/issue/')[1]?.split('/')[0] === summary.issueKey)) summary.issueUrl = url;
        const state = child(issue, 'state', fragments);
        const stateName = state && text(child(state, 'name', fragments)?.value, 80);
        if (stateName) summary.stateName = stateName;
        for (const [fieldName, summaryName] of [['assignee', 'assigneeName'], ['delegate', 'delegateName']] as const) {
          const user = child(issue, fieldName, fragments);
          if (user?.value === null) summary[summaryName] = null;
          else if (user) {
            const userName = text(child(user, 'name', fragments)?.value, 120);
            if (userName) summary[summaryName] = userName;
          }
        }
      }
    }
    return Object.keys(summary).length ? LinearApiSummary.parse(summary) : undefined;
  } catch {
    // Display extraction must not replace the caller's successful API result.
    return undefined;
  }
}

import { buildSchema, parse, validate } from 'graphql';

// A bounded contract fixture, checked against Linear's public schema on Oct10.
// Unlike substring-only mocks, this rejects malformed queries and union selections.
const schema = buildSchema(`
  scalar JSONObject
  type Query {
    teams(first: Int, after: String): TeamConnection!
    searchIssues(term: String!, first: Int, after: String): IssueSearchPayload!
    comment(id: String!): Comment!
    viewer: User!
    organization: Organization!
    applicationInfo(clientId: String!): Application!
    issue(id: String!): Issue!
    agentSession(id: String!): AgentSession!
    agentActivity(id: String!): AgentActivity!
  }
  type Mutation {
    issueCreate(input: IssueCreateInput!): IssuePayload!
    commentCreate(input: CommentCreateInput!): CommentPayload!
    issueUpdate(id: String!, input: IssueUpdateInput!): Success!
    agentActivityCreate(input: AgentActivityCreateInput!): ActivityPayload!
    agentSessionUpdate(id: String!, input: AgentSessionUpdateInput!): Success!
  }
  type User { id: ID!, app: Boolean!, name: String! }
  type Organization { id: ID!, name: String! }
  type Application { clientId: String! }
  type Success { success: Boolean! }
  type ActivityPayload { success: Boolean!, agentActivity: AgentActivity! }
  type Issue { id: ID!, identifier: String!, title: String!, description: String, url: String!, delegate: User, state: State!, team: Team!, comments(first: Int, after: String): CommentConnection! }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type IssueSearchPayload { nodes: [Issue!]!, pageInfo: PageInfo! }
  type IssuePayload { success: Boolean!, issue: Issue }
  type CommentPayload { success: Boolean!, comment: Comment }
  type Comment { id: ID!, issueId: String, agentSession: AgentSession, body: String!, url: String!, issue: Issue, parent: Comment, user: User }
  type CommentConnection { nodes: [Comment!]!, pageInfo: PageInfo! }
  type TeamConnection { nodes: [Team!]!, pageInfo: PageInfo! }
  input IssueCreateInput { id: String, teamId: String!, title: String!, description: String }
  input CommentCreateInput { id: String, issueId: String, parentId: String, body: String }

  type State { id: ID!, name: String!, type: String!, position: Float! }
  type Team { id: ID!, key: String!, name: String!, states: StateConnection! }
  type StateConnection { nodes: [State!]! }
  input IssueUpdateInput { stateId: String }
  type AgentSession { id: ID!, appUser: User!, activities(first: Int): ActivityConnection!, externalLinks: [ExternalLink!]! }
  type ExternalLink { url: String! }
  type ActivityConnection { nodes: [AgentActivity!]! }
  type AgentActivity { id: ID!, agentSession: AgentSession!, content: AgentActivityContent!, createdAt: String! }
  union AgentActivityContent = AgentActivityThoughtContent | AgentActivityPromptContent | AgentActivityResponseContent | AgentActivityErrorContent | AgentActivityElicitationContent | AgentActivityActionContent
  type AgentActivityThoughtContent { type: String!, body: String! }
  type AgentActivityPromptContent { type: String!, body: String! }
  type AgentActivityResponseContent { type: String!, body: String! }
  type AgentActivityErrorContent { type: String!, body: String! }
  type AgentActivityElicitationContent { type: String!, body: String! }
  type AgentActivityActionContent { type: String!, action: String!, parameter: String!, result: String }
  input AgentActivityCreateInput { id: String, agentSessionId: String!, content: JSONObject!, ephemeral: Boolean }
  input AgentSessionUpdateInput { addedExternalUrls: [ExternalUrlInput!] }
  input ExternalUrlInput { url: String!, label: String! }
`);

export function linearQueryErrors(query: string): string[] {
  try { return validate(schema, parse(query)).map((error) => error.message); }
  catch { return ['Invalid GraphQL syntax']; }
}

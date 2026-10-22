import { z } from 'zod';
import { LinearIdentityService } from './identity.service.js';

const Id = z.string().trim().min(1).max(256);
const Body = z.string().trim().min(1).max(100_000);
const Page = z.object({ limit: z.number().int().min(1).max(100).default(50), after: z.string().min(1).optional() });
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const Issue = z.object({ id: z.string(), identifier: z.string(), title: z.string(), url: z.string() });
const Comment = z.object({ id: z.string(), body: z.string(), url: z.string() });
const issueFields = 'id identifier title url';
const commentFields = 'id body url';

export const LinearIssueCreate = z.object({
  id: z.string().uuid(), teamId: z.string().uuid(), title: z.string().trim().min(1).max(512),
  description: z.string().max(100_000).optional(),
});
export const LinearCommentCreate = z.object({
  id: z.string().uuid(), issueId: Id, body: Body, parentId: z.string().uuid().optional(),
});

/** Ordinary workspace actions use the app's permissions, not inbox ownership. */
export class LinearIssueService {
  constructor(readonly identity: LinearIdentityService) {}

  async teams(page: { limit?: number; after?: string } = {}) {
    const { limit, after } = Page.parse(page);
    const result = await this.identity.request(
      'query($first:Int!,$after:String) { teams(first:$first,after:$after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }',
      { first: limit, after }, z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })), pageInfo: PageInfo }) }),
    );
    return result.teams;
  }

  async search(term: string, page: { limit?: number; after?: string } = {}) {
    const { limit, after } = Page.parse(page);
    const result = await this.identity.request(
      `query($term:String!,$first:Int!,$after:String) { searchIssues(term:$term,first:$first,after:$after) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`,
      { term: z.string().trim().min(1).max(1000).parse(term), first: limit, after },
      z.object({ searchIssues: z.object({ nodes: z.array(Issue), pageInfo: PageInfo }) }),
    );
    return result.searchIssues;
  }

  async read(id: string, page: { limit?: number; after?: string } = {}) {
    const { limit, after } = Page.parse(page);
    const result = await this.identity.request(
      `query($id:String!,$first:Int!,$after:String) { issue(id:$id) {
        ${issueFields} description state { name type } team { id key name }
        comments(first:$first,after:$after) { nodes { ${commentFields} user { id name } parent { id } } pageInfo { hasNextPage endCursor } }
      } }`, { id: Id.parse(id), first: limit, after }, z.object({ issue: Issue.extend({
        description: z.string().nullable(), state: z.object({ name: z.string(), type: z.string() }),
        team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
        comments: z.object({ nodes: z.array(Comment.extend({ user: z.object({ id: z.string(), name: z.string() }).nullable(), parent: z.object({ id: z.string() }).nullable() })), pageInfo: PageInfo }),
      }) }),
    );
    return result.issue;
  }

  async create(input: z.input<typeof LinearIssueCreate>) {
    const parsed = LinearIssueCreate.parse(input);
    const result = await this.identity.request(
      `mutation($input:IssueCreateInput!) { issueCreate(input:$input) { success issue { ${issueFields} } } }`,
      { input: parsed }, z.object({ issueCreate: z.object({ success: z.literal(true), issue: Issue }) }),
    );
    if (result.issueCreate.issue.id !== parsed.id) throw new Error('Linear returned a different issue id; inspect the issue before retrying.');
    return result.issueCreate.issue;
  }

  async comment(input: z.input<typeof LinearCommentCreate>) {
    const parsed = LinearCommentCreate.parse(input);
    const { installationId } = await this.identity.credentials();
    if (parsed.parentId) {
      const parent = await this.identity.graphql(installationId,
        'query($id:String!) { comment(id:$id) { issue { id identifier } parent { id } } }', { id: parsed.parentId },
        z.object({ comment: z.object({ issue: z.object({ id: z.string(), identifier: z.string() }).nullable(), parent: z.object({ id: z.string().uuid() }).nullable() }) }),
      );
      if (!parent.comment.issue || ![parent.comment.issue.id, parent.comment.issue.identifier].includes(parsed.issueId)) {
        throw new Error('The reply target does not belong to this issue.');
      }
      // Linear has one level of replies. A notification can point at a reply;
      // continuing that discussion must use its root, not create a nested thread.
      parsed.parentId = parent.comment.parent?.id ?? parsed.parentId;
    }
    const result = await this.identity.graphql(installationId,
      `mutation($input:CommentCreateInput!) { commentCreate(input:$input) { success comment { ${commentFields} } } }`,
      { input: parsed }, z.object({ commentCreate: z.object({ success: z.literal(true), comment: Comment }) }),
    );
    if (result.commentCreate.comment.id !== parsed.id) throw new Error('Linear returned a different comment id; inspect the comment before retrying.');
    const comment: z.infer<typeof Comment> & { parentId?: string } = result.commentCreate.comment;
    if (parsed.parentId) comment.parentId = parsed.parentId;
    return comment;
  }
}

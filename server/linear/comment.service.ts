import { z } from 'zod';
import { LinearIdentityService } from './identity.service.js';

const Id = z.string().trim().min(1).max(256);
const Body = z.string().trim().min(1).max(100_000);
const Comment = z.object({ id: z.string(), body: z.string(), url: z.string() });
const commentFields = 'id body url';
const CommentPlace = z.object({ comment: z.object({
  issue: z.object({ id: z.string(), identifier: z.string() }).nullable(), parent: z.object({ id: z.string().uuid() }).nullable(),
}) });

export const LinearCommentCreate = z.object({
  id: z.string().uuid(), issueId: Id, body: Body, parentId: z.string().uuid().optional(),
});

export const LinearCommentReply = z.object({
  id: z.string().uuid(), commentId: z.string().uuid(), body: Body,
});

export type LinearCreatedComment = z.infer<typeof Comment> & { issueId: string; parentId?: string };

/** Ordinary workspace actions use the app's permissions, not inbox ownership. */
export class LinearCommentService {
  constructor(readonly identity: LinearIdentityService) {}

  async comment(input: z.input<typeof LinearCommentCreate>): Promise<LinearCreatedComment> {
    const parsed = LinearCommentCreate.parse(input);
    const { installationId } = await this.identity.credentials();
    if (parsed.parentId) {
      const parent = await this.place(installationId, parsed.parentId);
      if (!parent.issue || ![parent.issue.id, parent.issue.identifier].includes(parsed.issueId)) {
        throw new Error('The reply target does not belong to this issue.');
      }
      // Linear has one level of replies. A notification can point at a reply;
      // continuing that discussion must use its root, not create a nested thread.
      parsed.parentId = parent.parent?.id ?? parsed.parentId;
    }
    return this.create(installationId, parsed);
  }

  /** Reply in the thread of an existing comment; its issue and thread root come from Linear. */
  async reply(input: z.input<typeof LinearCommentReply>): Promise<LinearCreatedComment> {
    const parsed = LinearCommentReply.parse(input);
    const { installationId } = await this.identity.credentials();
    const target = await this.place(installationId, parsed.commentId);
    if (!target.issue) throw new Error('The reply target comment is not on an issue this app can reach.');
    return this.create(installationId, { id: parsed.id, issueId: target.issue.id, parentId: target.parent?.id ?? parsed.commentId, body: parsed.body });
  }

  private async place(installationId: string, commentId: string) {
    return (await this.identity.graphql(installationId,
      'query($id:String!) { comment(id:$id) { issue { id identifier } parent { id } } }', { id: commentId }, CommentPlace)).comment;
  }

  private async create(installationId: string, parsed: z.infer<typeof LinearCommentCreate>): Promise<LinearCreatedComment> {
    const result = await this.identity.graphql(installationId,
      `mutation($input:CommentCreateInput!) { commentCreate(input:$input) { success comment { ${commentFields} } } }`,
      { input: parsed }, z.object({ commentCreate: z.object({ success: z.literal(true), comment: Comment }) }),
    );
    if (result.commentCreate.comment.id !== parsed.id) throw new Error('Linear returned a different comment id; inspect the comment before retrying.');
    const comment: LinearCreatedComment = { ...result.commentCreate.comment, issueId: parsed.issueId };
    if (parsed.parentId) comment.parentId = parsed.parentId;
    return comment;
  }
}

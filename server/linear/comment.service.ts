import { z } from 'zod';
import { LinearIdentityService } from './identity.service.js';

const Id = z.string().trim().min(1).max(256);
const Body = z.string().trim().min(1).max(100_000);
const Comment = z.object({ id: z.string(), body: z.string(), url: z.string() });
const commentFields = 'id body url';

export const LinearCommentCreate = z.object({
  id: z.string().uuid(), issueId: Id, body: Body, parentId: z.string().uuid().optional(),
});

/** Ordinary workspace actions use the app's permissions, not inbox ownership. */
export class LinearCommentService {
  constructor(readonly identity: LinearIdentityService) {}

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

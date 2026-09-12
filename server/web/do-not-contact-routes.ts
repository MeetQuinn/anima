import type { FastifyInstance } from 'fastify';
import { ContactMemberRequest, ContactWorkspaceId } from '../../shared/do-not-contact.js';
import { defaultDoNotContactService } from '../settings/do-not-contact.service.js';

export function registerDoNotContactRoutes(app: FastifyInstance): void {
  app.get('/api/do-not-contact', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { workspaces: await defaultDoNotContactService.list() };
  });
  app.get<{ Params: { workspaceId: string } }>('/api/do-not-contact/:workspaceId/users', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return defaultDoNotContactService.directory(ContactWorkspaceId.parse(request.params.workspaceId));
  });
  app.post<{ Params: { workspaceId: string } }>('/api/do-not-contact/:workspaceId/members', async (request) => {
    const workspaceId = ContactWorkspaceId.parse(request.params.workspaceId);
    const { userId } = ContactMemberRequest.parse(request.body);
    await defaultDoNotContactService.add(workspaceId, userId);
    return { ok: true };
  });
  app.delete<{ Params: { workspaceId: string } }>('/api/do-not-contact/:workspaceId/members', async (request) => {
    const workspaceId = ContactWorkspaceId.parse(request.params.workspaceId);
    const { userId } = ContactMemberRequest.parse(request.body);
    await defaultDoNotContactService.remove(workspaceId, userId);
    return { ok: true };
  });
}

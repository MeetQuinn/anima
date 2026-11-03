import { LINEAR_WEBHOOK_PATH } from '../../shared/linear.js';
import type { LinearSetup } from '../../shared/linear-setup.js';
import { serverConfigStore } from '../storage/schema/server.store.js';

/** Both Linear URLs live on the public address, which points at this dashboard. */
export class LinearSetupService {
  async read(): Promise<LinearSetup> {
    const { publicUrl } = await serverConfigStore.read();
    return {
      publicUrl,
      webhookUrl: publicUrl ? `${publicUrl}${LINEAR_WEBHOOK_PATH}` : undefined,
      callbackUrl: publicUrl ? `${publicUrl}/api/linear/oauth/callback` : undefined,
    };
  }
}

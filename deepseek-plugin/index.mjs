import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, logicalIdentity } from './adapter.mjs';
import { startTransport } from './transport.mjs';

export const name = 'codex-deepseek-bridge';
export const inject = ['sessionController', 'agents', 'pluginPackages', 'profileContext'];
export async function apply(ctx) {
  const identity = await logicalIdentity(ctx);
  const root = join(homedir(), '.dsh', 'codex-bridge');
  const adapter = await createAdapter(ctx, { root, ...identity });
  const transport = await startTransport({ root, ...identity, invoke: adapter.invoke });
  ctx.effect(() => () => transport.close(), 'codex-deepseek-bridge: private local transport');
  ctx.logger?.info?.(`Codex bridge ready for ${identity.identity.profile} Host ${identity.hostId}`);
}

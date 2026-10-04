import type { Session } from '../api.js';
import { OfflineStore, namespaceKey } from './offline-store.js';
let instance: OfflineStore | undefined;
let generation = 0;
export const deviceGeneration = () => generation;
export const deviceStore = () => (instance ??= new OfflineStore());
export const deviceChanged = () => window.dispatchEvent(new Event('imbox:device-data'));
export async function clearDeviceData() {
  generation += 1;
  const store = deviceStore();
  await store.transaction('rw', store.tables, async () => {
    for (const table of store.tables) await table.clear();
  });
  deviceChanged();
}
/** A new authenticated actor cannot inherit another actor's local cache or pending commands. */
export async function adoptDeviceSession(session: Session, expectedGeneration = generation) {
  const store = deviceStore(),
    identity = { tenantId: session.tenant_id, principalId: session.principal.id },
    key = namespaceKey(identity);
  await store.transaction('rw', store.tables, async () => {
    if (expectedGeneration !== generation) return;
    for (const pref of await store.preferences.toArray()) {
      if (pref.key === key) continue;
      const [tenantId, principalId] = JSON.parse(pref.key) as [string, string];
      await store.eraseIdentity({ tenantId, principalId });
    }
    await store.rememberSession(session);
  });
}

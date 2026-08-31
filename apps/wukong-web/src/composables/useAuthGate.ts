// apps/wukong-web/src/composables/useAuthGate.ts
// Auth readiness gates the main app. Once the first load finishes and auth is
// still missing, show a full-page login entry instead of an in-app banner.

import { computed, ref, watch } from 'vue';
import type { useWukongWebClient } from './useWukongWebClient';

type WukongWebClient = ReturnType<typeof useWukongWebClient>;

export interface UseAuthGateOptions {
  client: WukongWebClient;
}

export function useAuthGate({ client }: UseAuthGateOptions) {
  const authReady = computed(() => client.authReady.value);
  const showAuthGate = computed(
    () => client.initialized.value && !client.bootstrapError.value && !authReady.value,
  );
  const LOGIN_PATH = '/login';
  const authReturnPath = ref<string | null>(null);

  function currentPathWithSuffix(): string {
    if (typeof window === 'undefined') return '/';
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function replaceBrowserPath(path: string): void {
    if (typeof window === 'undefined') return;
    window.history.replaceState(window.history.state, '', path);
  }

  watch(showAuthGate, (show) => {
    if (typeof window === 'undefined') return;
    if (show) {
      if (window.location.pathname !== LOGIN_PATH) {
        authReturnPath.value = currentPathWithSuffix();
        replaceBrowserPath(LOGIN_PATH);
      }
      return;
    }
    if (window.location.pathname === LOGIN_PATH) {
      replaceBrowserPath(authReturnPath.value ?? '/');
      authReturnPath.value = null;
    }
  }, { immediate: true });

  return { showAuthGate };
}

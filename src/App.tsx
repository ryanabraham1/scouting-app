import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { AppRouter } from './routes/router';
import { queryClient, persistOptions } from './lib/queryPersist';
import { SyncController } from './sync/useSync';

export default function App(): JSX.Element {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      {/* Outbox drains run on every route, not just screens with a sync badge. */}
      <SyncController />
      <AppRouter />
    </PersistQueryClientProvider>
  );
}

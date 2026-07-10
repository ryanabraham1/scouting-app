import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { AppRouter } from './routes/router';
import { queryClient, persistOptions } from './lib/queryPersist';
import { PwaUpdatePrompt } from './pwa/PwaUpdatePrompt';

export default function App(): JSX.Element {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <AppRouter />
      <PwaUpdatePrompt />
    </PersistQueryClientProvider>
  );
}

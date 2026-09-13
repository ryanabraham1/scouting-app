import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { AppRouter } from './routes/router';
import { queryClient, persistOptions } from './lib/queryPersist';

export default function App(): JSX.Element {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <AppRouter />
    </PersistQueryClientProvider>
  );
}

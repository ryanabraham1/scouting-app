import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRouter } from './routes/router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
    },
  },
});

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AppRouter />
    </QueryClientProvider>
  );
}

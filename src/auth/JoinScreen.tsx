// src/auth/JoinScreen.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { joinEvent, recoverIdentity } from './joinEvent';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export function JoinScreen(): JSX.Element {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: (c: string, n: string) => Promise<unknown>): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await action(code, name);
      navigate('/scout');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function onJoin(e: FormEvent): void {
    e.preventDefault();
    void run(joinEvent);
  }

  function onRecover(): void {
    void run(recoverIdentity);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Join Event</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onJoin}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-code-input">Join code</Label>
              <Input
                id="join-code-input"
                data-testid="join-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-name-input">Display name</Label>
              <Input
                id="join-name-input"
                data-testid="join-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                className="h-11"
              />
            </div>
            {error !== null && (
              <p data-testid="join-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              data-testid="join-submit"
              type="submit"
              disabled={busy}
              className="h-11 w-full"
            >
              {busy ? 'Joining…' : 'Join'}
            </Button>
            <Button
              data-testid="recover-submit"
              type="button"
              variant="outline"
              onClick={onRecover}
              disabled={busy}
              className="h-11 w-full"
            >
              Recover my identity
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default JoinScreen;

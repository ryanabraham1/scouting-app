// src/auth/AdminLogin.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminSignIn } from './adminAuth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export function AdminLogin(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        await adminSignIn(email, password);
        navigate('/admin');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign in failed.');
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Admin Login</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-email-input">Email</Label>
              <Input
                id="admin-email-input"
                data-testid="admin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-password-input">Password</Label>
              <Input
                id="admin-password-input"
                data-testid="admin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="h-11"
              />
            </div>
            {error !== null && (
              <p
                data-testid="admin-login-error"
                role="alert"
                aria-live="assertive"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <Button
              data-testid="admin-login-submit"
              type="submit"
              disabled={busy}
              className="h-11 w-full"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default AdminLogin;

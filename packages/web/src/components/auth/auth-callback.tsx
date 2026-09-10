import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { exchangeLoginToken, exchangeAuthorizationCode } from "../../client/login";
import { MatrixClientPeg } from "../../client/peg";

interface AuthCallbackProps {
  homeserverUrl: string;
  authIssuer?: string;
}

export function AuthCallback({ homeserverUrl, authIssuer }: AuthCallbackProps) {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Handle SSO loginToken callback (traditional Matrix SSO)
    const loginToken = params.get("loginToken");
    if (loginToken) {
      exchangeLoginToken(homeserverUrl, loginToken)
        .then((creds) => {
          MatrixClientPeg.set(creds);
          setDone(true);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }

    // Handle OIDC authorization code callback (response_mode=fragment)
    const fragment = window.location.hash.slice(1);
    const fragmentParams = new URLSearchParams(fragment);
    const code = fragmentParams.get("code") ?? params.get("code");
    if (code && authIssuer) {
      const codeVerifier = sessionStorage.getItem("zooid_pkce_verifier");
      if (!codeVerifier) {
        setError("Missing PKCE verifier. Please try signing in again.");
        return;
      }
      const redirectUri = `${window.location.origin}/auth/callback`;
      exchangeAuthorizationCode(homeserverUrl, authIssuer, code, codeVerifier, redirectUri)
        .then((creds) => {
          sessionStorage.removeItem("zooid_pkce_verifier");
          MatrixClientPeg.set(creds);
          setDone(true);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
  }, [homeserverUrl, authIssuer, params]);

  if (!params.get("loginToken") && !window.location.hash.includes("code=")) {
    return <Navigate to="/login" replace />;
  }
  if (error) return <div role="alert">{error}</div>;
  if (done) return <Navigate to="/" replace />;
  return (
    <Empty className="min-h-screen" role="status">
      <EmptyHeader>
        <EmptyMedia>
          <Spinner aria-label="Completing sign-in" />
        </EmptyMedia>
        <EmptyDescription>Completing sign-in…</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

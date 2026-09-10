import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { exchangeLoginToken } from "../../client/login";
import { MatrixClientPeg } from "../../client/peg";

interface AuthCallbackProps {
  homeserverUrl: string;
}

export function AuthCallback({ homeserverUrl }: AuthCallbackProps) {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Check query params first (loginToken from Synapse SSO)
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

    // Check URL fragment for OIDC authorization code (response_mode=fragment)
    const fragment = window.location.hash.slice(1);
    const fragmentParams = new URLSearchParams(fragment);
    const code = fragmentParams.get("code") ?? params.get("code");
    if (code) {
      setError("OIDC authorization code received but token exchange is not yet implemented.");
      return;
    }
  }, [homeserverUrl, params]);

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

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
  const loginToken = params.get("loginToken");
  const authCode = params.get("code");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Handle SSO loginToken callback (traditional Matrix SSO)
    if (loginToken) {
      exchangeLoginToken(homeserverUrl, loginToken)
        .then((creds) => {
          MatrixClientPeg.set(creds);
          setDone(true);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }

    // Handle OIDC authorization code callback
    if (authCode) {
      // For OIDC, we need to exchange the auth code for tokens
      // This requires the OIDC provider's token endpoint
      // The web client will need to be configured with the OIDC provider details
      setError("OIDC authentication requires additional configuration. Please use the traditional login method or configure the OIDC provider.");
      return;
    }
  }, [homeserverUrl, loginToken, authCode]);

  if (!loginToken && !authCode) return <Navigate to="/login" replace />;
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

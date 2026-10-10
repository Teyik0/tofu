import type { ErrorProps } from "@teyik0/furin";
import { Alert, AlertDescription, AlertTitle } from "@tofu/ui/alert";
import { Button } from "@tofu/ui/button";
import { AlertCircleIcon } from "lucide-react";

export default function LibraryError({ reset }: ErrorProps) {
  return (
    <main className="main">
      <Alert className="connection-banner">
        <AlertCircleIcon />
        <AlertTitle>The Tofu engine is unavailable</AlertTitle>
        <AlertDescription>
          <p>The data could not be loaded.</p>
          <Button onClick={reset} variant="outline">
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </main>
  );
}

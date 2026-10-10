import type { ErrorProps } from "@teyik0/furin";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";

const PageError = ({ reset }: ErrorProps) => (
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

export default PageError;

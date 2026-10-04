import type { ErrorProps } from "@teyik0/furin";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";

export default function LibraryError({ reset }: ErrorProps) {
  return (
    <main className="main">
      <Alert className="connection-banner">
        <AlertCircleIcon />
        <AlertTitle>Le moteur Tofu est indisponible</AlertTitle>
        <AlertDescription>
          <p>Les données n’ont pas pu être chargées.</p>
          <Button onClick={reset} variant="outline">
            Réessayer
          </Button>
        </AlertDescription>
      </Alert>
    </main>
  );
}

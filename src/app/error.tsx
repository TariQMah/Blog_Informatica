"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui";

const isDevelopment = () => process.env.NODE_ENV !== "production";

export default function AppError({
  error: appError,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isDevelopment()) console.error("App error:", appError);
  }, [appError]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
        <AlertTriangle className="h-8 w-8 text-red-600 dark:text-red-400" />
      </div>
      <h1 className="mb-2 text-2xl font-semibold">Algo salió mal</h1>
      <p className="mb-6 max-w-md text-muted-foreground">
        Ocurrió un error inesperado. Probá de nuevo o volvé al inicio.
      </p>
      <div className="flex items-center gap-3">
        <Button onClick={reset} variant="default">
          Reintentar
        </Button>
<Link href="/" className={buttonVariants({ variant: "outline" })}>
  Ir al inicio
</Link>
      </div>
      {appError.digest && (
        <p className="mt-4 text-xs text-muted-foreground">
          Error ID: {appError.digest}
        </p>
      )}
    </div>
  );
}

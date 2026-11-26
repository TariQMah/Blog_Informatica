import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center bg-background">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="h-8 w-8 text-muted-foreground" />
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-foreground">
        Página no encontrada
      </h1>
      <p className="mb-6 max-w-md text-muted-foreground">
        La página que buscás no existe o fue movida.
      </p>
<Link href="/" className={buttonVariants({ variant: "default" })}>
  Ir al inicio
</Link>
    </div>
  );
}

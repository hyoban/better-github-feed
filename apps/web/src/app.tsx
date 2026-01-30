import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { NuqsAdapter } from "nuqs/adapters/react-router";
import { isRouteErrorResponse, Outlet, useRouteError } from "react-router-dom";

import { Toaster } from "./components/ui/sonner";
import { persister, queryClient } from "./utils/orpc";

export function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => {
            // Persist all successful queries
            return query.state.status === "success";
          },
        },
      }}
    >
      <NuqsAdapter>
        <div className="h-svh overflow-hidden">
          <Outlet />
        </div>
      </NuqsAdapter>
      <Toaster richColors />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
    </PersistQueryClientProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

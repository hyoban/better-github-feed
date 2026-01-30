import { createBrowserRouter } from "react-router-dom";

import { App, ErrorBoundary } from "./app";
import { Home } from "./pages/home";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    errorElement: <ErrorBoundary />,
    children: [
      {
        index: true,
        element: <Home />,
      },
    ],
  },
]);

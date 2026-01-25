import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type FocusedPanel = "sidebar" | "feed";

// Context for focused panel state
const FocusedPanelContext = createContext<{
  focusedPanel: FocusedPanel;
  setFocusedPanel: (panel: FocusedPanel) => void;
} | null>(null);

export function FocusedPanelProvider({ children }: { children: React.ReactNode }) {
  const [focusedPanel, setFocusedPanel] = useState<FocusedPanel>("feed");

  return (
    <FocusedPanelContext.Provider value={{ focusedPanel, setFocusedPanel }}>
      {children}
    </FocusedPanelContext.Provider>
  );
}

export function useFocusedPanel() {
  const context = useContext(FocusedPanelContext);
  if (!context) {
    throw new Error("useFocusedPanel must be used within FocusedPanelProvider");
  }
  return [context.focusedPanel, context.setFocusedPanel] as const;
}

export function useKeyboardNavigation(onNavigate: (direction: "up" | "down") => void) {
  const [, setFocusedPanel] = useFocusedPanel();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case "ArrowLeft": {
          e.preventDefault();
          setFocusedPanel("sidebar");
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          setFocusedPanel("feed");
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          onNavigate("up");
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          onNavigate("down");
          break;
        }
      }
    },
    [setFocusedPanel, onNavigate],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

import { useEffect, useState } from "react";
import { DesktopInventory } from "./components/DesktopInventory";
import { TooltipProvider } from "./components/ui/tooltip";
import { desktopMode } from "./data/desktopInventory";
import { Modals } from "./components/Modals";
import { Shell } from "./components/Shell";
import { ToastStack } from "./components/ui";
import { useEventsStore } from "./stores/events";
import { useHostStore } from "./stores/host";
import { useNavigationStore } from "./stores/navigation";
import { useUiStore } from "./stores/ui";

export function App() {
  const [isDesktop] = useState(() => desktopMode(window.pidock, navigator.userAgent));
  // Production desktop path, wrapped once so every shadcn Tooltip (vendored
  // Radix) has its provider; the demo path renders DemoApp below.
  if (isDesktop) return <TooltipProvider><DesktopInventory /></TooltipProvider>;
  return <DemoApp />;
}

function DemoApp() {
  const refresh = useHostStore((state) => state.refresh);
  const attach = useEventsStore((state) => state.attach);
  const syncFromLocation = useNavigationStore((state) => state.syncFromLocation);
  const toasts = useUiStore((state) => state.toasts);
  const dismissToast = useUiStore((state) => state.dismissToast);

  useEffect(() => {
    syncFromLocation();
    void refresh();
    const unsubscribe = attach();
    const onPopState = () => syncFromLocation();
    window.addEventListener("popstate", onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onPopState);
    };
  }, [attach, refresh, syncFromLocation]);

  return (
    <>
      <Shell />
      <Modals />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

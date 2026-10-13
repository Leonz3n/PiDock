import { useEffect, useState } from "react";
import { DesktopInventory } from "./components/DesktopInventory";
import { TooltipProvider } from "./components/ui/tooltip";
import { desktopMode } from "./data/desktopInventory";
// [UI 对齐 S8c] #47 carried fix: these three imports are the DEMO path, and they
// are static, so `data/memoryHost.ts`'s module-level fixture workspace is still
// constructed into the packaged renderer bundle even though the desktop edge no
// longer reaches it. Keeping the imports is deliberate in this slice (see the
// report); no measurement may claim the fixture module is out of the bundle until
// the demo path is lazy-loaded.
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

import { useEffect } from "react";
import { Modals } from "./components/Modals";
import { Shell } from "./components/Shell";
import { ToastStack } from "./components/ui";
import { useEventsStore } from "./stores/events";
import { useHostStore } from "./stores/host";
import { useNavigationStore } from "./stores/navigation";
import { useUiStore } from "./stores/ui";

export function App() {
  const refresh = useHostStore((state) => state.refresh);
  const attach = useEventsStore((state) => state.attach);
  const syncFromLocation = useNavigationStore((state) => state.syncFromLocation);
  const toasts = useUiStore((state) => state.toasts);
  const dismissToast = useUiStore((state) => state.dismissToast);

  useEffect(() => {
    syncFromLocation();
    void refresh();
    const unsubscribe = attach(useHostStore.getState().adapter);
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

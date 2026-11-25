import { lazy, Suspense } from "react";
import { Alert, Button, useOverlayState } from "@heroui/react";
import { FileText } from "lucide-react";
import { useActiveServer } from "../hooks/useActiveConnection";
import { t } from "../i18n/es";
import { useUnsaved } from "../store/unsaved";

const ExportDialog = lazy(() => import("./ExportDialog"));

/** Reminder shown after changes made through the API, which MediaMTX does not write to its file. */
export function UnsavedBanner() {
  const { server } = useActiveServer();
  const unsaved = useUnsaved((s) => (server ? s.since[server.id] : undefined));
  const clear = useUnsaved((s) => s.clear);
  const dialog = useOverlayState();
  if (!server || !unsaved) return null;
  return (
    <>
      <Alert status="warning" className="mb-4">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{t.unsaved.message}</Alert.Description>
        </Alert.Content>
        <div className="flex shrink-0 flex-wrap gap-2 self-center">
          <Button size="sm" variant="secondary" onPress={dialog.open}>
            <FileText size={14} aria-hidden />
            {t.unsaved.export}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => clear(server.id)}>{t.unsaved.dismiss}</Button>
        </div>
      </Alert>
      {dialog.isOpen ? (
        <Suspense fallback={null}>
          <ExportDialog state={dialog} serverName={server.name} />
        </Suspense>
      ) : null}
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Button, Spinner, toast, type useOverlayState } from "@heroui/react";
import { Download, Eye, EyeOff } from "lucide-react";
import { copyText } from "../core/clipboard";
import { getPathDefaults, listPathConfs } from "../core/mediamtx/api";
import type { RawPathConf } from "../core/mediamtx/types";
import { pathsToYaml } from "../core/yaml";
import { usePathApi } from "../hooks/usePathApi";
import { t } from "../i18n/es";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

/** Loaded on demand: it pulls in the overlay components and the YAML writer. */
export default function ExportDialog({ state, serverName }: { state: ReturnType<typeof useOverlayState>; serverName: string }) {
  const api = usePathApi();
  const [confs, setConfs] = useState<RawPathConf[] | null>(null);
  const [defaults, setDefaults] = useState<RawPathConf | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    if (!api.client) return;
    let cancelled = false;
    Promise.all([listPathConfs(api.client), getPathDefaults(api.client).catch(() => null)])
      .then(([list, d]) => {
        if (cancelled) return;
        setConfs(list);
        setDefaults(d);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // Read once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const header = useMemo(() => `Exportado por Nodo desde ${serverName}\n${new Date().toISOString()}`, [serverName]);
  const full = useMemo(() => (confs ? pathsToYaml(confs, { defaults, header }) : ""), [confs, defaults, header]);
  const shown = useMemo(() => (confs ? pathsToYaml(confs, { defaults, header, mask: !showSecrets }) : ""), [confs, defaults, header, showSecrets]);

  const copy = async () => {
    if (await copyText(full)) toast.success(t.unsaved.copied);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([full], { type: "text/yaml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "mediamtx-paths.yml";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ResponsiveOverlay
      state={state}
      title={t.unsaved.title}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onPress={download} isDisabled={!confs}>
            <Download size={16} aria-hidden />
            {t.unsaved.download}
          </Button>
          <Button variant="primary" onPress={copy} isDisabled={!confs}>{t.unsaved.copy}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--muted)]">{t.unsaved.help}</p>
        {failed ? <p className="text-sm text-[var(--danger)]">{t.unsaved.failed}</p> : null}
        {!confs && !failed ? (
          <div className="grid place-items-center py-10"><Spinner /></div>
        ) : null}
        {confs ? (
          <>
            <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--surface-secondary)] p-3 text-xs leading-relaxed" aria-label="YAML">{shown}</pre>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onPress={() => setShowSecrets((v) => !v)}>
                {showSecrets ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                {t.unsaved.showSecrets}
              </Button>
              <span className="text-xs text-[var(--warning)]">{t.unsaved.secrets}</span>
            </div>
          </>
        ) : null}
      </div>
    </ResponsiveOverlay>
  );
}

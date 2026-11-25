import { useRef, useState } from "react";
import { Button, Card, Label, ListBox, Select, Switch, toast } from "@heroui/react";
import { Download, Upload } from "lucide-react";
import { exportServers, parseImport } from "../core/serversIO";
import { fmt, t } from "../i18n/es";
import { POLL_INTERVALS_MS, usePrefs, type PollIntervalMs, type ThemePref } from "../store/prefs";
import { useServers } from "../store/servers";

const THEMES: Array<{ id: ThemePref; label: string }> = [
  { id: "system", label: t.settings.themeSystem },
  { id: "light", label: t.settings.themeLight },
  { id: "dark", label: t.settings.themeDark },
];

/** Triggers a browser download. The Android build will use the Share sheet instead. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function SettingsPage() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const interval = usePrefs((s) => s.pollIntervalMs);
  const setInterval_ = usePrefs((s) => s.setPollIntervalMs);
  const servers = useServers((s) => s.servers);
  const addServers = useServers((s) => s.addServers);
  const [includePasswords, setIncludePasswords] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const doExport = () => {
    download("mediamtx-panel-servers.json", exportServers(servers, includePasswords));
    toast.success(t.settings.exported);
  };

  const doImport = async (file: File) => {
    try {
      const { servers: incoming, warnings } = parseImport(
        await file.text(),
        new Set(useServers.getState().servers.map((s) => s.id)),
      );
      if (incoming.length === 0) {
        toast.warning(t.settings.importedNone);
        return;
      }
      addServers(incoming);
      toast.success(fmt(t.settings.imported, { n: incoming.length }), {
        description: warnings.length ? fmt(t.settings.importWarnings, { n: warnings.length }) : undefined,
      });
    } catch {
      toast.danger(t.settings.importFailed);
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.settings.title}</h1>

      <Card>
        <Card.Header>
          <Card.Title>{t.settings.appearance}</Card.Title>
        </Card.Header>
        <Card.Content className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            selectedKey={theme}
            onSelectionChange={(key) => setTheme(String(key) as ThemePref)}
            aria-label={t.settings.theme}
          >
            <Label>{t.settings.theme}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {THEMES.map((item) => (
                  <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                    {item.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          <Select
            selectedKey={String(interval)}
            onSelectionChange={(key) => setInterval_(Number(key) as PollIntervalMs)}
            aria-label={t.settings.refresh}
          >
            <Label>{t.settings.refresh}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {POLL_INTERVALS_MS.map((ms) => {
                  const label = fmt(t.settings.seconds, { n: ms / 1000 });
                  return (
                    <ListBox.Item key={ms} id={String(ms)} textValue={label}>
                      {label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  );
                })}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="text-xs text-[var(--muted)] sm:col-span-2">{t.settings.refreshHelp}</p>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.settings.backup}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <Switch isSelected={includePasswords} onChange={setIncludePasswords}>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <Label>{t.settings.includePasswords}</Label>
              <p className="text-xs text-[var(--muted)]">{t.settings.includePasswordsHelp}</p>
            </Switch.Content>
          </Switch>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onPress={doExport} isDisabled={servers.length === 0}>
              <Download size={16} aria-hidden />
              {t.settings.export}
            </Button>
            <Button variant="secondary" onPress={() => fileInput.current?.click()}>
              <Upload size={16} aria-hidden />
              {t.settings.import}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void doImport(file);
                event.target.value = "";
              }}
            />
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}

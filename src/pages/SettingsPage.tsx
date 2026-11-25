import { useRef, useState } from "react";
import { Button, Card, Label, ListBox, Select, Switch, toast, useOverlayState } from "@heroui/react";
import { Download, Upload } from "lucide-react";
import { AgentPasswordOverlay } from "../components/AgentPasswordOverlay";
import { SecuritySettings } from "../components/auth/SecuritySettings";
import { exportServers, parseImport } from "../core/serversIO";
import { fmt, t } from "../i18n/es";
import { hrefFor } from "../router";
import { POLL_INTERVALS_MS, usePrefs, type PollIntervalMs, type ThemePref } from "../store/prefs";
import { useServers } from "../store/servers";
import { useActiveAgent } from "../hooks/useAgentClient";

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
  const { server, agent, client } = useActiveAgent();
  const updateServer = useServers((s) => s.updateServer);
  const passwordDialog = useOverlayState();
  const agentUser = server && !server.demo ? agent?.username : undefined;

  const doExport = () => {
    download("nodo-servers.json", exportServers(servers, includePasswords));
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

      {server && agentUser && agent && client ? (
        <Card>
          <Card.Content className="flex flex-row items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t.agentAccount.title}</p>
              <p className="truncate text-xs text-[var(--muted)]">
                {fmt(t.agentAccount.help, { server: server.name })} {fmt(t.agentAccount.user, { user: agentUser })}
              </p>
            </div>
            <Button size="sm" variant="secondary" onPress={passwordDialog.open}>
              {t.agentAccount.change}
            </Button>
          </Card.Content>
          <AgentPasswordOverlay
            state={passwordDialog}
            username={agentUser}
            onChange={async (current, next) => {
              // The stored credentials must match the agent's, or the next request logs in with the old password.
              await client.changePassword(current, next);
              const { id: _id, ...draft } = server;
              updateServer(server.id, { ...draft, agent: { ...agent, password: next } });
              toast.success(t.agentAccount.changed);
            }}
          />
        </Card>
      ) : null}

      <Card>
        <Card.Content className="flex flex-row items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t.settings.mediamtxConfig}</p>
            <p className="text-xs text-[var(--muted)]">{t.settings.mediamtxConfigHelp}</p>
          </div>
          <a
            href={hrefFor({ name: "config" })}
            className="rounded-xl bg-[var(--surface-secondary)] px-3 py-2 text-sm font-medium"
          >
            {t.settings.open}
          </a>
        </Card.Content>
      </Card>

      <Card>
        <Card.Content className="flex flex-row items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t.settings.system}</p>
            <p className="text-xs text-[var(--muted)]">{t.settings.systemHelp}</p>
          </div>
          <a
            href={hrefFor({ name: "system" })}
            className="rounded-xl bg-[var(--surface-secondary)] px-3 py-2 text-sm font-medium"
          >
            {t.settings.open}
          </a>
        </Card.Content>
      </Card>

      <Card>
        <Card.Content className="flex flex-row items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t.settings.binaries}</p>
            <p className="text-xs text-[var(--muted)]">{t.settings.binariesHelp}</p>
          </div>
          <a
            href={hrefFor({ name: "binaries" })}
            className="rounded-xl bg-[var(--surface-secondary)] px-3 py-2 text-sm font-medium"
          >
            {t.settings.open}
          </a>
        </Card.Content>
      </Card>

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

      <SecuritySettings />

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

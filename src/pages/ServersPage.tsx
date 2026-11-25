import { useState } from "react";
import { AlertDialog, Button, Card, Chip, EmptyState, useOverlayState } from "@heroui/react";
import { Pencil, Plus, Server as ServerIcon, Trash2 } from "lucide-react";
import { EndpointProbeList } from "../components/EndpointProbeList";
import { ServerFormOverlay } from "../components/ServerFormOverlay";
import type { Server, ServerDraft } from "../core/types";
import { fmt, t } from "../i18n/es";
import { connectionOf, useConnection } from "../store/connection";
import { useServers } from "../store/servers";

export default function ServersPage() {
  const servers = useServers((s) => s.servers);
  const activeId = useServers((s) => s.activeServerId);
  const { addServer, updateServer, removeServer, setActiveServer, addDemoServer } = useServers.getState();

  const form = useOverlayState();
  const confirm = useOverlayState();
  const [editing, setEditing] = useState<Server | undefined>();
  const [deleting, setDeleting] = useState<Server | undefined>();

  const openAdd = () => {
    setEditing(undefined);
    form.open();
  };
  const openEdit = (server: Server) => {
    setEditing(server);
    form.open();
  };
  const save = (draft: ServerDraft) => {
    if (editing) updateServer(editing.id, draft);
    else addServer(draft);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.servers.title}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{t.servers.subtitle}</p>
        </div>
        <div className="flex gap-2 max-lg:hidden">
          {servers.some((s) => s.demo) ? null : (
            <Button variant="secondary" onPress={() => addDemoServer()}>
              {t.servers.addDemo}
            </Button>
          )}
          <Button variant="primary" onPress={openAdd}>
            <Plus size={16} aria-hidden />
            {t.servers.add}
          </Button>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <ServerIcon size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.servers.emptyTitle}</p>
          <p className="text-sm text-[var(--muted)]">{t.servers.emptyBody}</p>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              isActive={server.id === activeId}
              onUse={() => setActiveServer(server.id)}
              onEdit={() => openEdit(server)}
              onDelete={() => {
                setDeleting(server);
                confirm.open();
              }}
            />
          ))}
        </div>
      )}

      {/* Primary action on mobile: floating button above the tab bar. */}
      <Button
        variant="primary"
        onPress={openAdd}
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] z-10 rounded-2xl shadow-lg lg:hidden"
        aria-label={t.servers.add}
      >
        <Plus size={18} aria-hidden />
        {t.servers.add}
      </Button>

      <ServerFormOverlay state={form} server={editing} onSave={save} />

      <AlertDialog isOpen={confirm.isOpen} onOpenChange={confirm.setOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t.servers.deleteTitle}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{fmt(t.servers.deleteBody, { name: deleting?.name ?? "" })}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={confirm.close}>
                  {t.servers.cancel}
                </Button>
                <Button
                  variant="danger"
                  onPress={() => {
                    if (deleting) removeServer(deleting.id);
                    confirm.close();
                  }}
                >
                  {t.servers.confirmDelete}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}

interface ServerCardProps {
  server: Server;
  isActive: boolean;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ServerCard({ server, isActive, onUse, onEdit, onDelete }: ServerCardProps) {
  const connection = useConnection((s) => connectionOf(s.byServer, server.id));
  const test = useConnection((s) => s.test);
  const tested = useConnection((s) => s.tests[server.id]);
  const testing = useConnection((s) => s.testing[server.id] ?? false);

  // The active server shows its live resolution until a manual test replaces it.
  const results = tested ?? (isActive ? connection.probes : undefined);
  const activeType = isActive && connection.status === "online" ? connection.active?.endpoint.type : undefined;

  return (
    <Card>
      <Card.Header className="flex flex-row items-center gap-2">
        <span className="size-3.5 shrink-0 rounded-full" style={{ background: server.color }} aria-hidden />
        <Card.Title className="min-w-0 flex-1 truncate">{server.name}</Card.Title>
        {server.demo ? (
          <Chip size="sm" color="accent" variant="soft">
            {t.servers.demo}
          </Chip>
        ) : null}
        {isActive ? (
          <Chip size="sm" color="success" variant="soft">
            {t.servers.active}
          </Chip>
        ) : null}
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {server.demo ? (
          <p className="text-sm text-[var(--muted)]">{t.servers.demoNote}</p>
        ) : (
          <EndpointProbeList endpoints={server.endpoints} results={results} activeType={activeType} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {server.demo ? null : (
            <Button size="sm" variant="secondary" isPending={testing} onPress={() => void test(server)}>
              {testing ? t.servers.testing : t.servers.test}
            </Button>
          )}
          {!isActive ? (
            <Button size="sm" variant="tertiary" onPress={onUse}>
              {t.servers.use}
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {server.demo ? null : (
              <Button size="sm" variant="ghost" onPress={onEdit}>
                <Pencil size={14} aria-hidden />
                {t.servers.edit}
              </Button>
            )}
            <Button size="sm" variant="danger-soft" isIconOnly aria-label={t.servers.delete} onPress={onDelete}>
              <Trash2 size={14} aria-hidden />
            </Button>
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}

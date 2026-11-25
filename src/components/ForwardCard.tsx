import { useCallback, useEffect, useState } from "react";
import {
  AlertDialog, Button, Card, Chip, FieldError, Input, Label, ListBox, Select, Spinner, TextField, toast, useOverlayState,
} from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import {
  destinationFromKey, FORWARD_PRESETS, forwardKind, maskDestination, readForwardList, validateDestination,
  type ForwardEntry,
} from "../core/forward";
import { getPathConf, listForwardDests, patchPathConf, type RawForwardDest } from "../core/mediamtx/api";
import { apiErrorMessage, usePathApi } from "../hooks/usePathApi";
import { fmt, t } from "../i18n/es";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

const STATE_COLOR = { forwarding: "success", idle: "default", error: "danger" } as const;

interface ForwardCardProps {
  channel: string;
  dynamic: boolean;
}

/** Destinations MediaMTX copies the channel to (`forward` list), with their live state. */
export function ForwardCard({ channel, dynamic }: ForwardCardProps) {
  const api = usePathApi();
  const [list, setList] = useState<ForwardEntry[] | null>(null);
  const [runtime, setRuntime] = useState<RawForwardDest[]>([]);
  const addDialog = useOverlayState();
  const removeDialog = useOverlayState();
  const [removing, setRemoving] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!api.client || dynamic) return;
    try {
      const conf = await getPathConf(api.client, channel);
      setList(readForwardList(conf.forward));
      setRuntime(await listForwardDests(api.client, channel).catch(() => []));
    } catch {
      setList((current) => current ?? []);
    }
  }, [api.client, channel, dynamic]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  const save = async (next: ForwardEntry[], success: string) => {
    if (!api.client) return false;
    try {
      await patchPathConf(api.client, channel, { forward: next });
      api.wrote();
      setList(next);
      toast.success(success);
      void load();
      return true;
    } catch (error) {
      toast.danger(t.forward.failed, { description: apiErrorMessage(error, "") || undefined });
      return false;
    }
  };

  const stateOf = (index: number): keyof typeof STATE_COLOR | "unknown" => {
    const sorted = [...runtime].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    // Runtime entries are matched by position; with a different count the match would be a guess.
    return list && sorted.length === list.length ? (sorted[index]?.state ?? "unknown") : "unknown";
  };

  return (
    <Card>
      <Card.Header className="flex flex-row items-start justify-between gap-2">
        <div>
          <Card.Title>{t.forward.title}</Card.Title>
          <p className="mt-0.5 text-xs text-[var(--muted)]">{t.forward.help}</p>
        </div>
        {dynamic ? null : (
          <Button size="sm" variant="secondary" onPress={addDialog.open} isDisabled={!api.client}>
            <Plus size={14} aria-hidden />
            {t.forward.add}
          </Button>
        )}
      </Card.Header>
      <Card.Content>
        {dynamic ? (
          <p className="text-sm text-[var(--muted)]">{t.forward.dynamicNote}</p>
        ) : list === null ? (
          <div className="grid place-items-center py-6"><Spinner size="sm" /></div>
        ) : list.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{t.forward.empty}</p>
        ) : (
          <ul>
            {list.map((entry, index) => {
              const state = stateOf(index);
              const detail = runtime.find((r) => r.pos === index + 1)?.lastError;
              return (
                <li key={`${entry.dest}-${index}`} className="flex flex-col gap-1 border-b border-[var(--border)] py-2.5 last:border-0">
                  <div className="flex items-center gap-2">
                    <Chip size="sm" color="accent" variant="soft">{forwardKind(entry.dest) ?? "?"}</Chip>
                    <code className="min-w-0 flex-1 truncate text-xs">{maskDestination(entry.dest)}</code>
                    <Chip size="sm" color={state === "unknown" ? "default" : STATE_COLOR[state]} variant="soft">
                      {t.forward.states[state]}
                    </Chip>
                    <Button
                      size="sm" variant="ghost" isIconOnly aria-label={t.forward.remove}
                      onPress={() => { setRemoving(index); removeDialog.open(); }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </div>
                  {state === "error" && detail ? <p className="text-xs text-[var(--danger)]">{detail}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card.Content>

      {addDialog.isOpen ? (
        <AddDestination
          state={addDialog}
          onAdd={async (dest) => (await save([...(list ?? []), { dest }], t.forward.added))}
        />
      ) : null}

      <AlertDialog isOpen={removeDialog.isOpen} onOpenChange={removeDialog.setOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t.forward.removeTitle}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{fmt(t.forward.removeBody, { dest: removing !== null && list?.[removing] ? maskDestination(list[removing]!.dest) : "" })}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={removeDialog.close}>{t.edit.cancel}</Button>
                <Button
                  variant="danger"
                  onPress={async () => {
                    if (removing !== null && list) await save(list.filter((_, i) => i !== removing), t.forward.removed);
                    removeDialog.close();
                  }}
                >
                  {t.forward.remove}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </Card>
  );
}

function AddDestination({ state, onAdd }: { state: ReturnType<typeof useOverlayState>; onAdd: (dest: string) => Promise<boolean> }) {
  const [preset, setPreset] = useState<string>("youtube");
  const [key, setKey] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = FORWARD_PRESETS.find((p) => p.id === preset)!;
  const isCustom = selected.id === "custom";

  const submit = async () => {
    let dest: string;
    if (isCustom) {
      const problem = validateDestination(custom);
      if (problem) return setError(t.forward.errors[problem]);
      dest = custom.trim();
    } else {
      if (!key.trim()) return setError(t.forward.errors.key);
      dest = destinationFromKey(selected.base, key);
    }
    setPending(true);
    const ok = await onAdd(dest);
    setPending(false);
    if (ok) state.close();
  };

  return (
    <ResponsiveOverlay
      state={state}
      title={t.forward.addTitle}
      footer={
        <>
          <Button variant="tertiary" onPress={state.close}>{t.edit.cancel}</Button>
          <Button variant="primary" onPress={submit} isPending={pending}>{t.forward.save}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Select selectedKey={preset} onSelectionChange={(k) => { setPreset(String(k)); setError(null); }} aria-label={t.forward.platform}>
          <Label>{t.forward.platform}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {FORWARD_PRESETS.map((p) => (
                <ListBox.Item key={p.id} id={p.id} textValue={p.label}>{p.label}<ListBox.ItemIndicator /></ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        {isCustom ? (
          <TextField value={custom} onChange={(v) => { setCustom(v); setError(null); }} isInvalid={!!error} autoComplete="off">
            <Label>{t.forward.destination}</Label>
            <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="rtmps://servidor/app#clave" />
            <FieldError>{error}</FieldError>
          </TextField>
        ) : (
          <>
            <code className="break-all rounded-lg bg-[var(--surface-secondary)] px-3 py-2 text-xs">{selected.base}</code>
            <TextField value={key} onChange={(v) => { setKey(v); setError(null); }} isInvalid={!!error} autoComplete="off">
              <Label>{t.forward.streamKey}</Label>
              <Input type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <FieldError>{error}</FieldError>
            </TextField>
          </>
        )}
        <p className="text-xs text-[var(--muted)]">{isCustom ? t.forward.destinationHelp : t.forward.streamKeyHelp} {t.forward.checkUrl}</p>
      </form>
    </ResponsiveOverlay>
  );
}

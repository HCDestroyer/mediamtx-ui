import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, FieldError, Input, Label, ListBox, Select, Spinner, Switch, TextArea, TextField, toast,
  type UseOverlayStateReturn,
} from "@heroui/react";
import { Eye, EyeOff } from "lucide-react";
import { copyText } from "../core/clipboard";
import { ApiError, addPathConf, getPathConf, patchPathConf } from "../core/mediamtx/api";
import {
  buildCreate, buildPatch, confToForm, EMPTY_FORM, formToConf, validateForm, type FormErrors, type PathForm,
} from "../core/mediamtx/pathConf";
import type { RawPathConf } from "../core/mediamtx/types";
import { generatePassphrase } from "../core/passphrase";
import { pathToYaml } from "../core/yaml";
import { apiErrorMessage, usePathApi } from "../hooks/usePathApi";
import { fmt, t } from "../i18n/es";
import { useChannels } from "../store/channels";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

export type EditorTarget = { kind: "new" } | { kind: "edit"; name: string };

interface PathEditorProps {
  state: UseOverlayStateReturn;
  target: EditorTarget;
}

const FORM_ID = "path-editor-form";

/** Mounted only while open so every opening starts from the server's current configuration. */
export function PathEditor({ state, target }: PathEditorProps) {
  return state.isOpen ? <EditorBody key={target.kind === "edit" ? target.name : "new"} state={state} target={target} /> : null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-[var(--border)] pt-4 first:border-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[var(--muted)]">{children}</p>;
}

function EditorBody({ state, target }: PathEditorProps) {
  const api = usePathApi();
  // Select the stable list and derive the names: a selector must not build a new array on every read.
  const channels = useChannels((s) => s.channels);
  const existingNames = useMemo(() => channels.map((c) => c.name), [channels]);
  const editing = target.kind === "edit";

  // `loading` while reading the current configuration; `original` stays null for a new path
  // and for a dynamic channel, which has no configuration of its own yet.
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState(false);
  const [original, setOriginal] = useState<RawPathConf | null>(null);
  const [converting, setConverting] = useState(false);
  const [form, setForm] = useState<PathForm>({ ...EMPTY_FORM, name: editing ? target.name : "" });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showYaml, setShowYaml] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    if (target.kind !== "edit" || !api.client) return setLoading(false);
    let cancelled = false;
    getPathConf(api.client, target.name)
      .then((conf) => {
        if (cancelled) return;
        setOriginal(conf);
        setForm(confToForm(target.name, conf, api.hook));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setConverting(true);
        else setLoadError(true);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // The configuration is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const creating = !editing || converting;
  const set = <K extends keyof PathForm>(key: K, value: PathForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setSubmitError(null);
  };
  const errorText = (key: keyof PathForm) => (errors[key] ? t.edit.errors[errors[key]!] : undefined);

  const yaml = useMemo(() => {
    const merged: RawPathConf = { ...(original ?? api.pathDefaults ?? {}), ...formToConf(form, api.hook), name: form.name || "…" };
    return pathToYaml(merged, { defaults: api.pathDefaults, mask: !showSecrets });
  }, [form, original, api.pathDefaults, api.hook, showSecrets]);

  const submit = async () => {
    if (!api.client) return;
    // A dynamic channel already shows up in the list: giving it a configuration is not a duplicate.
    const found = validateForm(form, { creating, existingNames: converting ? [] : existingNames });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    setSubmitError(null);
    try {
      const name = form.name.trim();
      if (creating) {
        await addPathConf(api.client, name, buildCreate(form, api.hook, api.pathDefaults));
      } else {
        const patch = buildPatch(original ?? {}, form, api.hook);
        if (Object.keys(patch).length === 0) {
          toast.info(t.edit.nothingToSave);
          return state.close();
        }
        await patchPathConf(api.client, name, patch);
      }
      api.wrote();
      toast.success(creating && !converting ? t.edit.created : t.edit.saved);
      state.close();
    } catch (error) {
      setSubmitError(apiErrorMessage(error, t.edit.saveFailed));
    } finally {
      setPending(false);
    }
  };

  const copyYaml = async () => {
    const full = pathToYaml({ ...(original ?? api.pathDefaults ?? {}), ...formToConf(form, api.hook), name: form.name }, { defaults: api.pathDefaults });
    if (await copyText(full)) toast.success(t.unsaved.copied);
  };

  const footer = (
    <>
      <Button variant="tertiary" onPress={() => setShowYaml((v) => !v)} isDisabled={loading}>
        {showYaml ? t.edit.hideYaml : t.edit.viewYaml}
      </Button>
      <div className="flex-1" />
      <Button variant="secondary" onPress={state.close}>{t.edit.cancel}</Button>
      <Button variant="primary" onPress={submit} isPending={pending} isDisabled={loading || loadError || !api.client}>
        {t.edit.save}
      </Button>
    </>
  );

  const passphraseField = (key: "sourcePassphrase" | "srtPublishPassphrase" | "srtReadPassphrase", label: string) => (
    <div className="flex items-end gap-2">
      <TextField className="min-w-0 flex-1" value={form[key]} onChange={(v) => set(key, v)} isInvalid={!!errors[key]} autoComplete="off">
        <Label>{label}</Label>
        <Input type={showSecrets ? "text" : "password"} spellCheck={false} />
        <FieldError>{errorText(key)}</FieldError>
      </TextField>
      <Button variant="secondary" onPress={() => set(key, generatePassphrase())}>{t.edit.generate}</Button>
    </div>
  );

  const srtSource = form.sourceMode === "url" && /^srt:\/\//i.test(form.sourceUrl.trim());

  return (
    <ResponsiveOverlay state={state} title={creating && !converting ? t.edit.newTitle : t.edit.editTitle} footer={footer} size="lg">
      {loading ? (
        <div className="grid place-items-center py-16"><Spinner /></div>
      ) : loadError ? (
        <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Description>{t.edit.loadFailed}</Alert.Description></Alert.Content></Alert>
      ) : (
        <form id={FORM_ID} onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-5">
          {converting ? (
            <Alert status="warning"><Alert.Indicator /><Alert.Content><Alert.Description>{t.edit.dynamicNotice}</Alert.Description></Alert.Content></Alert>
          ) : null}
          {submitError ? (
            <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{t.edit.saveFailed}</Alert.Title><Alert.Description>{submitError}</Alert.Description></Alert.Content></Alert>
          ) : null}

          <TextField value={form.name} onChange={(v) => set("name", v)} isDisabled={!creating || converting} isInvalid={!!errors.name} autoFocus={creating && !converting}>
            <Label>{t.edit.name}</Label>
            <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="canal63" />
            <FieldError>{errorText("name")}</FieldError>
          </TextField>
          <Hint>{!creating || converting ? t.edit.nameLocked : t.edit.nameHelp}</Hint>

          <Section title={t.edit.secSource}>
            {form.sourceMode === "other" ? (
              <>
                <code className="break-all rounded-lg bg-[var(--surface-secondary)] px-3 py-2 text-xs">{form.sourceUrl}</code>
                <Hint>{t.edit.sourceOther}</Hint>
              </>
            ) : (
              <>
                <Select selectedKey={form.sourceMode} onSelectionChange={(key) => set("sourceMode", String(key) as PathForm["sourceMode"])} aria-label={t.edit.sourceType}>
                  <Label>{t.edit.sourceType}</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="publisher" textValue={t.edit.sourcePublisher}>{t.edit.sourcePublisher}<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="url" textValue={t.edit.sourceUrl}>{t.edit.sourceUrl}<ListBox.ItemIndicator /></ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
                {form.sourceMode === "url" ? (
                  <>
                    <TextField value={form.sourceUrl} onChange={(v) => set("sourceUrl", v)} isInvalid={!!errors.sourceUrl}>
                      <Label>{t.edit.url}</Label>
                      <Input inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={t.edit.urlPlaceholder} />
                      <FieldError>{errorText("sourceUrl")}</FieldError>
                    </TextField>
                    {srtSource ? passphraseField("sourcePassphrase", t.edit.sourcePassphrase) : null}
                    <Switch isSelected={form.sourceOnDemand} onChange={(v) => set("sourceOnDemand", v)}>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                      <Switch.Content><Label>{t.edit.onDemand}</Label><Hint>{t.edit.onDemandHelp}</Hint></Switch.Content>
                    </Switch>
                  </>
                ) : null}
              </>
            )}
          </Section>

          <Section title={t.edit.secSrt}>
            {passphraseField("srtPublishPassphrase", t.edit.srtPublish)}
            {passphraseField("srtReadPassphrase", t.edit.srtRead)}
            <Hint>{t.edit.passphraseHelp}</Hint>
          </Section>

          <Section title={t.edit.secHooks}>
            <TextField value={form.hookCommand} onChange={(v) => set("hookCommand", v)}>
              <Label>{t.edit.hookCommand}</Label>
              <TextArea rows={3} spellCheck={false} className="font-mono text-xs" />
            </TextField>
            <Hint>{fmt(t.edit.hookHelp, { key: api.hook.command })}</Hint>
            <Switch isSelected={form.hookRestart} onChange={(v) => set("hookRestart", v)}>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              <Switch.Content><Label>{t.edit.hookRestart}</Label></Switch.Content>
            </Switch>
          </Section>

          <Section title={t.edit.secRecord}>
            <Switch isSelected={form.record} onChange={(v) => set("record", v)}>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              <Switch.Content><Label>{t.edit.record}</Label></Switch.Content>
            </Switch>
            {form.record ? (
              <div className="flex flex-col gap-3">
                <TextField value={form.recordPath} onChange={(v) => set("recordPath", v)} isInvalid={!!errors.recordPath}>
                  <Label>{t.edit.recordPath}</Label>
                  <Input spellCheck={false} className="font-mono text-xs" />
                  <FieldError>{errorText("recordPath")}</FieldError>
                </TextField>
                <Select selectedKey={form.recordFormat} onSelectionChange={(key) => set("recordFormat", String(key) as PathForm["recordFormat"])} aria-label={t.edit.recordFormat}>
                  <Label>{t.edit.recordFormat}</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="fmp4" textValue="fMP4">fMP4<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="mpegts" textValue="MPEG-TS">MPEG-TS<ListBox.ItemIndicator /></ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextField value={form.recordSegmentDuration} onChange={(v) => set("recordSegmentDuration", v)} isInvalid={!!errors.recordSegmentDuration}>
                    <Label>{t.edit.recordSegment}</Label>
                    <Input spellCheck={false} />
                    <FieldError>{errorText("recordSegmentDuration")}</FieldError>
                  </TextField>
                  <TextField value={form.recordDeleteAfter} onChange={(v) => set("recordDeleteAfter", v)} isInvalid={!!errors.recordDeleteAfter}>
                    <Label>{t.edit.recordDelete}</Label>
                    <Input spellCheck={false} />
                    <FieldError>{errorText("recordDeleteAfter")}</FieldError>
                  </TextField>
                </div>
                <Hint>{t.edit.durationHelp}</Hint>
              </div>
            ) : null}
          </Section>

          {showYaml ? (
            <Section title={t.edit.viewYaml}>
              <Hint>{t.edit.yamlHelp}</Hint>
              <pre className="max-h-64 overflow-auto rounded-lg bg-[var(--surface-secondary)] p-3 text-xs leading-relaxed">{yaml}</pre>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onPress={copyYaml}>{t.unsaved.copy}</Button>
                <Button size="sm" variant="ghost" onPress={() => setShowSecrets((v) => !v)}>
                  {showSecrets ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                  {showSecrets ? t.edit.hide : t.edit.showSecrets}
                </Button>
              </div>
            </Section>
          ) : null}
        </form>
      )}
    </ResponsiveOverlay>
  );
}

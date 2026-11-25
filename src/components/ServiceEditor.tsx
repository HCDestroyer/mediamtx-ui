import { useState, type FormEvent } from "react";
import { Button, FieldError, Form, Input, Label, ListBox, Select, Switch, TextField, type UseOverlayStateReturn } from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { AgentError } from "../core/agent/api";
import {
  EMPTY_SERVICE_FORM, formToService, hasErrors, MAX_INPUTS, MAX_OUTPUTS, serviceToForm, validateServiceForm,
  type ServiceForm, type ServiceFormErrorCode,
} from "../core/agent/form";
import type { AgentService, StreamKind } from "../core/agent/types";
import { t } from "../i18n/es";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

const FORM_ID = "service-form";
const KINDS: StreamKind[] = ["video", "audio", "subtitle", "data"];
const KIND_LABEL: Record<StreamKind, string> = {
  video: t.services.video, audio: t.services.audio, subtitle: t.services.subtitles, data: t.services.data,
};

const message = (code: ServiceFormErrorCode | undefined) => (code ? t.services.errors[code] : undefined);

interface ServiceEditorProps {
  state: UseOverlayStateReturn;
  /** Service being edited, or undefined to create one. */
  service?: AgentService;
  /** Sends the service to the agent; rejects with the agent's error. */
  onSave: (service: ReturnType<typeof formToService>) => Promise<void>;
}

export function ServiceEditor(props: ServiceEditorProps) {
  // Mounted only while open so every open starts from fresh fields.
  return props.state.isOpen ? <EditorBody key={props.service?.id ?? "new"} {...props} /> : null;
}

function EditorBody({ state, service, onSave }: ServiceEditorProps) {
  const [form, setForm] = useState<ServiceForm>(() => (service ? serviceToForm(service) : structuredClone(EMPTY_SERVICE_FORM)));
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = validateServiceForm(form);
  const visible = shown ? errors : { inputs: [], outputs: [], streams: [] };

  const patch = (changes: Partial<ServiceForm>) => setForm((f) => ({ ...f, ...changes }));
  const updateAt = <K extends "inputs" | "outputs" | "streams">(key: K, index: number, changes: Partial<ServiceForm[K][number]>) =>
    setForm((f) => ({ ...f, [key]: f[key].map((row, i) => (i === index ? { ...row, ...changes } : row)) }));
  const removeAt = (key: "inputs" | "outputs" | "streams", index: number) =>
    setForm((f) => ({ ...f, [key]: f[key].filter((_, i) => i !== index) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    if (hasErrors(errors)) return;
    setSaving(true);
    setServerError(null);
    try {
      await onSave(formToService(form));
      state.close();
    } catch (error) {
      setServerError(error instanceof AgentError ? (error.detail ?? error.message) : t.services.failed);
      setSaving(false);
    }
  };

  const footer = (
    <Button variant="primary" type="submit" form={FORM_ID} isPending={saving}>
      {t.services.form.save}
    </Button>
  );

  return (
    <ResponsiveOverlay state={state} title={service ? t.services.form.editTitle : t.services.form.addTitle} footer={footer} size="lg">
      <Form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-5" validationBehavior="aria">
        <TextField name="name" value={form.name} onChange={(name) => patch({ name })} isInvalid={!!visible.name} autoFocus>
          <Label>{t.services.form.name}</Label>
          <Input placeholder={t.services.form.namePlaceholder} />
          <FieldError>{message(visible.name)}</FieldError>
        </TextField>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t.services.form.inputsTitle}</legend>
          <p className="text-xs text-[var(--muted)]">{t.services.form.inputsHelp}</p>
          {form.inputs.map((input, i) => (
            <div key={i} className="flex items-start gap-2">
              <TextField className="min-w-0 flex-1" value={input.url} onChange={(url) => updateAt("inputs", i, { url })} isInvalid={!!visible.inputs[i]?.url} aria-label={`${t.services.form.address} ${i + 1}`}>
                <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="udp://eth0@239.1.1.1:1234" />
                <FieldError>{message(visible.inputs[i]?.url)}</FieldError>
              </TextField>
              <TextField className="w-24" value={input.timeoutSec} onChange={(timeoutSec) => updateAt("inputs", i, { timeoutSec })} isInvalid={!!visible.inputs[i]?.timeoutSec} aria-label={t.services.form.timeout}>
                <Input inputMode="numeric" placeholder={t.services.form.timeout} />
                <FieldError>{message(visible.inputs[i]?.timeoutSec)}</FieldError>
              </TextField>
              <Button isIconOnly size="sm" variant="ghost" aria-label={t.services.form.removeRow} onPress={() => removeAt("inputs", i)} isDisabled={form.inputs.length === 1}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
          {visible.general === "inputs-required" ? <p role="alert" className="text-xs text-[var(--danger)]">{message(visible.general)}</p> : null}
          <div>
            <Button size="sm" variant="tertiary" isDisabled={form.inputs.length >= MAX_INPUTS} onPress={() => patch({ inputs: [...form.inputs, { url: "", timeoutSec: "" }] })}>
              <Plus size={14} aria-hidden />
              {t.services.form.addInput}
            </Button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t.services.form.backup}</legend>
          <Select selectedKey={form.backupMode} onSelectionChange={(key) => patch({ backupMode: key === "manual" ? "manual" : "active" })} aria-label={t.services.form.backup}>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="active" textValue={t.services.form.backupActive}>{t.services.form.backupActive}</ListBox.Item>
                <ListBox.Item id="manual" textValue={t.services.form.backupManual}>{t.services.form.backupManual}</ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
          {form.backupMode === "active" ? (
            <TextField value={form.returnDelaySec} onChange={(returnDelaySec) => patch({ returnDelaySec })} isInvalid={!!visible.returnDelaySec}>
              <Label>{t.services.form.returnDelay}</Label>
              <Input inputMode="numeric" />
              <FieldError>{message(visible.returnDelaySec)}</FieldError>
            </TextField>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t.services.form.profile}</legend>
          <p className="text-xs text-[var(--muted)]">{t.services.form.profileHelp}</p>
          <div className="grid grid-cols-2 gap-3">
            <TextField value={form.serviceId} onChange={(serviceId) => patch({ serviceId })} isInvalid={!!visible.serviceId}>
              <Label>{t.services.form.serviceId}</Label>
              <Input inputMode="numeric" />
              <FieldError>{message(visible.serviceId)}</FieldError>
            </TextField>
            <TextField value={form.pmtPid} onChange={(pmtPid) => patch({ pmtPid })} isInvalid={!!visible.pmtPid}>
              <Label>{t.services.form.pmtPid}</Label>
              <Input inputMode="numeric" />
              <FieldError>{message(visible.pmtPid)}</FieldError>
            </TextField>
            <TextField value={form.provider} onChange={(provider) => patch({ provider })}>
              <Label>{t.services.form.provider}</Label>
              <Input />
            </TextField>
            <TextField value={form.cbrKbps} onChange={(cbrKbps) => patch({ cbrKbps })} isInvalid={!!visible.cbrKbps}>
              <Label>{t.services.form.cbr}</Label>
              <Input inputMode="numeric" placeholder={t.services.form.cbrHelp} />
              <FieldError>{message(visible.cbrKbps)}</FieldError>
            </TextField>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t.services.form.streams}</span>
            {form.streams.map((stream, i) => (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <TextField className="w-20" value={stream.pid} onChange={(pid) => updateAt("streams", i, { pid })} isInvalid={!!visible.streams[i]?.pid} aria-label={t.services.form.pid}>
                  <Input inputMode="numeric" placeholder={t.services.form.pid} />
                  <FieldError>{message(visible.streams[i]?.pid)}</FieldError>
                </TextField>
                <Select className="w-32" selectedKey={stream.kind} onSelectionChange={(key) => updateAt("streams", i, { kind: String(key) as StreamKind })} aria-label={t.services.form.kind}>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {KINDS.map((kind) => (
                        <ListBox.Item key={kind} id={kind} textValue={KIND_LABEL[kind]}>{KIND_LABEL[kind]}</ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <TextField className="w-20" value={stream.lang} onChange={(lang) => updateAt("streams", i, { lang })} isInvalid={!!visible.streams[i]?.lang} aria-label={t.services.form.lang}>
                  <Input autoCapitalize="none" maxLength={3} placeholder={t.services.form.langPlaceholder} />
                  <FieldError>{message(visible.streams[i]?.lang)}</FieldError>
                </TextField>
                <Switch isSelected={stream.fallbackAny} onChange={(fallbackAny) => updateAt("streams", i, { fallbackAny })} aria-label={t.services.form.fallbackAny}>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Switch.Content>
                    <span className="text-xs">{t.services.form.fallbackAny}</span>
                  </Switch.Content>
                </Switch>
                <Button isIconOnly size="sm" variant="ghost" className="ml-auto" aria-label={t.services.form.removeRow} onPress={() => removeAt("streams", i)}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              </div>
            ))}
            {visible.general === "streams-required" ? <p role="alert" className="text-xs text-[var(--danger)]">{message(visible.general)}</p> : null}
            <div>
              <Button size="sm" variant="tertiary" onPress={() => patch({ streams: [...form.streams, { pid: "", kind: "audio", lang: "", fallbackAny: false }] })}>
                <Plus size={14} aria-hidden />
                {t.services.form.addStream}
              </Button>
            </div>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t.services.form.outputsTitle}</legend>
          <p className="text-xs text-[var(--muted)]">{t.services.form.outputsHelp}</p>
          {form.outputs.map((output, i) => (
            <div key={i} className="flex items-start gap-2">
              <TextField className="min-w-0 flex-1" value={output.url} onChange={(url) => updateAt("outputs", i, { url })} isInvalid={!!visible.outputs[i]?.url} aria-label={`${t.services.form.address} ${i + 1}`}>
                <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="udp://239.2.2.2:1234#ttl=32" />
                <FieldError>{message(visible.outputs[i]?.url)}</FieldError>
              </TextField>
              <Button isIconOnly size="sm" variant="ghost" aria-label={t.services.form.removeRow} onPress={() => removeAt("outputs", i)} isDisabled={form.outputs.length === 1}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
          {visible.general === "outputs-required" ? <p role="alert" className="text-xs text-[var(--danger)]">{message(visible.general)}</p> : null}
          <div>
            <Button size="sm" variant="tertiary" isDisabled={form.outputs.length >= MAX_OUTPUTS} onPress={() => patch({ outputs: [...form.outputs, { url: "" }] })}>
              <Plus size={14} aria-hidden />
              {t.services.form.addOutput}
            </Button>
          </div>
        </fieldset>

        {serverError ? <p role="alert" className="text-sm text-[var(--danger)]">{serverError}</p> : null}
      </Form>
    </ResponsiveOverlay>
  );
}

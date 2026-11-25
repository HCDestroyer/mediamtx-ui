import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Chip, EmptyState, Spinner, toast } from "@heroui/react";
import { FileCog, RotateCcw } from "lucide-react";
import { AgentError } from "../core/agent/api";
import type { MtxConfigState } from "../core/agent/types";
import { useActiveAgent } from "../hooks/useAgentClient";
import { fmt, t } from "../i18n/es";
import { hrefFor } from "../router";

type Checked = { ok: true; merged: string } | { ok: false; error: string } | null;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.config.title}</h1>
        <p className="text-sm text-[var(--muted)]">{t.config.subtitle}</p>
      </div>
      {children}
    </div>
  );
}

export default function ConfigPage() {
  const { agent, client } = useActiveAgent();
  const [state, setState] = useState<MtxConfigState | null>(null);
  const [problem, setProblem] = useState<"unreachable" | "unauthorized" | "disabled" | null>(null);
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Checked>(null);
  const [busy, setBusy] = useState<"validate" | "apply" | "undo" | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const next = await client.mtxState();
      setState(next);
      setText(next.overlay);
      setChecked(null);
      setProblem(null);
    } catch (error) {
      const status = error instanceof AgentError ? error.status : 0;
      setProblem(status === 404 ? "disabled" : status === 401 || status === 403 ? "unauthorized" : "unreachable");
    }
  }, [client]);

  useEffect(() => {
    setState(null);
    void load();
  }, [load]);

  if (!agent || !client) {
    return (
      <Frame>
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <FileCog size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.config.noAgentTitle}</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">{t.config.noAgentBody}</p>
          <a href={hrefFor({ name: "servers" })} className="text-sm font-medium text-[var(--accent)] underline">
            {t.config.noAgentAction}
          </a>
        </EmptyState>
      </Frame>
    );
  }

  if (problem) {
    return (
      <Frame>
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>
              {problem === "disabled" ? t.config.notEnabled : problem === "unauthorized" ? t.config.unauthorized : t.config.unreachable}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </Frame>
    );
  }

  if (!state) {
    return (
      <Frame>
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      </Frame>
    );
  }

  const dirty = text !== state.overlay;

  const validate = async () => {
    setBusy("validate");
    try {
      setChecked(await client.mtxValidate(text));
    } catch (error) {
      setChecked({ ok: false, error: error instanceof AgentError ? (error.detail ?? t.config.failed) : t.config.failed });
    }
    setBusy(null);
  };

  const apply = async () => {
    setBusy("apply");
    try {
      const next = await client.mtxApply(text);
      setState(next);
      setChecked(null);
      toast.success(t.config.applied);
    } catch (error) {
      // 422 carries the reason; the previous configuration is still in place.
      setChecked({ ok: false, error: error instanceof AgentError ? (error.detail ?? t.config.failed) : t.config.failed });
    }
    setBusy(null);
  };

  const undo = async () => {
    setBusy("undo");
    try {
      const next = await client.mtxUndo();
      setState(next);
      setText(next.overlay);
      setChecked(null);
      toast.success(t.config.undone);
    } catch (error) {
      toast.danger(t.config.failed, { description: error instanceof AgentError ? (error.detail ?? undefined) : undefined });
    }
    setBusy(null);
  };

  return (
    <Frame>
      <Card>
        <Card.Content className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--muted)]">{t.config.howBody}</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
            <dt className="text-[var(--muted)]">{t.config.base}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="min-w-0 truncate font-mono text-xs">{state.basePath || "—"}</code>
              {state.basePath && !state.baseFound ? (
                <Chip size="sm" color="warning" variant="soft">
                  {t.config.baseMissing}
                </Chip>
              ) : null}
            </dd>
            <dt className="text-[var(--muted)]">{t.config.output}</dt>
            <dd className="min-w-0">
              <code className="block truncate font-mono text-xs">{fmt(t.config.outputHint, { path: state.outPath })}</code>
            </dd>
          </dl>
          <div>
            <Chip size="sm" color={state.validator ? "success" : "default"} variant="soft">
              {state.validator ? t.config.validatorOn : t.config.validatorOff}
            </Chip>
          </div>
        </Card.Content>
      </Card>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="overlay" className="text-sm font-medium">
          {t.config.editorLabel}
        </label>
        <p className="text-xs text-[var(--muted)]">{t.config.editorHelp}</p>
        <textarea
          id="overlay"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setChecked(null);
          }}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          rows={16}
          placeholder={t.config.placeholder}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--field-background)] p-3 font-mono text-xs leading-relaxed outline-none focus-visible:border-[var(--focus)]"
        />
      </div>

      {checked ? (
        checked.ok ? (
          <details className="rounded-xl border border-[var(--border)] p-3 text-sm">
            <summary className="cursor-pointer font-medium text-[var(--success)]">{t.config.valid}</summary>
            <pre className="mt-2 max-h-72 overflow-auto font-mono text-xs">{checked.merged}</pre>
          </details>
        ) : (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>{t.config.invalid}</Alert.Title>
              <Alert.Description className="font-mono text-xs">{checked.error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onPress={apply} isPending={busy === "apply"} isDisabled={!dirty || busy !== null}>
          {busy === "apply" ? t.config.applying : t.config.apply}
        </Button>
        <Button variant="secondary" onPress={validate} isPending={busy === "validate"} isDisabled={busy !== null}>
          {busy === "validate" ? t.config.validating : t.config.validate}
        </Button>
        {dirty ? (
          <Button variant="ghost" onPress={() => { setText(state.overlay); setChecked(null); }}>
            {t.config.revert}
          </Button>
        ) : null}
        <Chip size="sm" variant="soft" color={dirty ? "warning" : "success"} className="ml-1">
          {dirty ? t.config.unsaved : t.config.saved}
        </Chip>
        <Button variant="ghost" className="ml-auto" onPress={undo} isDisabled={!state.canUndo || busy !== null}>
          <RotateCcw size={14} aria-hidden />
          {t.config.undo}
        </Button>
      </div>
    </Frame>
  );
}

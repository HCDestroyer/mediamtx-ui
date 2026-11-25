import { useState, type FormEvent, type ReactNode } from "react";
import {
  Button, Card, Chip, FieldError, Form, Input, Label, ListBox, Modal, Select, TextField, toast,
  useOverlayState, type UseOverlayStateReturn,
} from "@heroui/react";
import { Lock } from "lucide-react";
import { fmt, t } from "../../i18n/es";
import { useAuth } from "../../store/auth";
import { AUTO_LOCK_MINUTES, usePrefs, type AutoLockMinutes } from "../../store/prefs";
import { AccountForm } from "./AccountForm";

interface DialogProps {
  state: UseOverlayStateReturn;
  title: string;
  footer: ReactNode;
  children: ReactNode;
}

function Dialog({ state, title, footer, children }: DialogProps) {
  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container size="md" scroll="inside">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
            <Modal.Footer>{footer}</Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** Asks for the current password before turning protection off. */
function DisableDialog({ state }: { state: UseOverlayStateReturn }) {
  const disable = useAuth((s) => s.disable);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    const ok = await disable(password);
    setPending(false);
    if (!ok) return setError(t.auth.wrongCurrent);
    state.close();
    toast.success(t.auth.disabled);
  };

  return (
    <Dialog
      state={state}
      title={t.auth.disableTitle}
      footer={
        <>
          <Button variant="tertiary" onPress={state.close}>{t.auth.cancel}</Button>
          <Button variant="danger" type="submit" form="disable-form" isPending={pending}>{t.auth.disableConfirm}</Button>
        </>
      }
    >
      <Form id="disable-form" onSubmit={submit} className="flex flex-col gap-3" validationBehavior="aria">
        <p className="text-sm text-[var(--muted)]">{t.auth.disableBody}</p>
        <TextField type="password" value={password} onChange={(v) => { setPassword(v); setError(null); }} isInvalid={!!error} autoComplete="current-password" autoFocus>
          <Label>{t.auth.password}</Label>
          <Input />
          <FieldError>{error}</FieldError>
        </TextField>
      </Form>
    </Dialog>
  );
}

/** Settings card: turn protection on or off, auto-lock, change credentials, lock now. */
export function SecuritySettings() {
  const status = useAuth((s) => s.status);
  const username = useAuth((s) => s.username);
  const createAccount = useAuth((s) => s.createAccount);
  const change = useAuth((s) => s.change);
  const lock = useAuth((s) => s.lock);
  const autoLock = usePrefs((s) => s.autoLockMinutes);
  const setAutoLock = usePrefs((s) => s.setAutoLockMinutes);

  const enableDialog = useOverlayState();
  const changeDialog = useOverlayState();
  const disableDialog = useOverlayState();
  const [pending, setPending] = useState(false);

  const on = status === "unlocked";

  return (
    <Card>
      <Card.Header className="flex flex-row items-center justify-between gap-2">
        <Card.Title>{t.auth.securityTitle}</Card.Title>
        <Chip size="sm" color={on ? "success" : "default"} variant="soft">
          {on ? t.auth.protected : t.auth.unprotected}
        </Chip>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {on ? (
          <>
            <p className="text-sm text-[var(--muted)]">
              {t.auth.username}: <span className="font-semibold text-[var(--foreground)]">{username}</span>
            </p>
            <Select selectedKey={String(autoLock)} onSelectionChange={(key) => setAutoLock(Number(key) as AutoLockMinutes)} aria-label={t.auth.autoLock}>
              <Label>{t.auth.autoLock}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {AUTO_LOCK_MINUTES.map((minutes) => {
                    const label = minutes === 0 ? t.auth.never : fmt(t.auth.minutes, { n: minutes });
                    return (
                      <ListBox.Item key={minutes} id={String(minutes)} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    );
                  })}
                </ListBox>
              </Select.Popover>
            </Select>
            <p className="-mt-2 text-xs text-[var(--muted)]">{t.auth.autoLockHelp}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onPress={changeDialog.open}>{t.auth.change}</Button>
              <Button variant="secondary" onPress={lock}>
                <Lock size={16} aria-hidden />
                {t.auth.lockNow}
              </Button>
              <Button variant="danger-soft" onPress={disableDialog.open}>{t.auth.disable}</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-[var(--muted)]">{t.auth.enableHelp}</p>
            <div>
              <Button variant="secondary" onPress={enableDialog.open}>{t.auth.enable}</Button>
            </div>
          </>
        )}
      </Card.Content>

      {enableDialog.isOpen ? (
        <Dialog
          state={enableDialog}
          title={t.auth.setupTitle}
          footer={
            <>
              <Button variant="tertiary" onPress={enableDialog.close}>{t.auth.cancel}</Button>
              <Button variant="primary" type="submit" form="enable-form" isPending={pending}>{t.auth.setupCreate}</Button>
            </>
          }
        >
          <AccountForm
            id="enable-form"
            mode="create"
            onPendingChange={setPending}
            onSubmit={async ({ username: u, password }) => {
              await createAccount(u, password);
              enableDialog.close();
              toast.success(t.auth.enabled);
              return null;
            }}
          />
        </Dialog>
      ) : null}

      {changeDialog.isOpen ? (
        <Dialog
          state={changeDialog}
          title={t.auth.changeTitle}
          footer={
            <>
              <Button variant="tertiary" onPress={changeDialog.close}>{t.auth.cancel}</Button>
              <Button variant="primary" type="submit" form="change-form" isPending={pending}>{t.auth.changeSave}</Button>
            </>
          }
        >
          <AccountForm
            id="change-form"
            mode="change"
            initialUsername={username}
            onPendingChange={setPending}
            onSubmit={async ({ currentPassword, username: u, password }) => {
              if (!(await change(currentPassword, u, password))) return t.auth.wrongCurrent;
              changeDialog.close();
              toast.success(t.auth.changed);
              return null;
            }}
          />
        </Dialog>
      ) : null}

      {disableDialog.isOpen ? <DisableDialog state={disableDialog} /> : null}
    </Card>
  );
}
